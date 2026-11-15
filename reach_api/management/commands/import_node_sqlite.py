import sqlite3
from pathlib import Path
from django.contrib.auth.models import User
from django.core.management.base import BaseCommand
from reach_api.models import Contact, Plan, Wallet


class Command(BaseCommand):
    help = 'Import users, wallets, contacts, and plans from the existing Node SQLite database.'
    def add_arguments(self, parser): parser.add_argument('--source', default='data/reach.sqlite')
    def handle(self, *args, **options):
        source = Path(options['source']); connection = sqlite3.connect(source); connection.row_factory = sqlite3.Row
        users = connection.execute('select * from users').fetchall()
        for row in users:
            email = row['email'].lower(); user, created = User.objects.get_or_create(username=email, defaults={'email': email, 'first_name': row['name'], 'password': row['password_hash'] or ''})
            if created: user.save()
            wallet = connection.execute('select credits from wallets where user_id = ? order by credits desc limit 1', (row['id'],)).fetchone()
            Wallet.objects.update_or_create(user=user, defaults={'credits': int(wallet['credits']) if wallet else 0})
            for contact in connection.execute('select * from contacts where user_id = ?', (row['id'],)).fetchall():
                Contact.objects.get_or_create(user=user, phone=contact['phone'], defaults={'first_name': contact['first_name'], 'last_name': contact['last_name'] or '', 'consent': bool(contact['consent'])})
        for plan in connection.execute('select id, name, credits, price_ghs from plans').fetchall(): Plan.objects.update_or_create(id=plan['id'], defaults={'name': plan['name'], 'credits': plan['credits'], 'price_ghs': plan['price_ghs']})
        self.stdout.write(self.style.SUCCESS(f'Imported {len(users)} users. Existing Node password hashes are upgraded on the first successful login.'))
