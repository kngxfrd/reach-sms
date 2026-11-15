from django.core.management.base import BaseCommand
from reach_api.models import Plan


PLANS = [
    ('starter', 'Starter', 100, 3), ('growth', 'Growth', 500, 15), ('scale', 'Scale', 1000, 30),
    ('launch', 'Launch', 2500, 75), ('momentum', 'Momentum', 5000, 150), ('pro', 'Pro', 10000, 300),
    ('business', 'Business', 25000, 750), ('plus', 'Plus', 50000, 1500), ('enterprise', 'Enterprise', 100000, 3000),
    ('volume', 'Volume', 250000, 7500), ('scale-up', 'Scale up', 500000, 15000), ('maximum', 'Maximum', 1000000, 30000),
]


class Command(BaseCommand):
    help = 'Create or update Reach credit plans.'
    def handle(self, *args, **options):
        for plan_id, name, credits, price in PLANS: Plan.objects.update_or_create(id=plan_id, defaults={'name': name, 'credits': credits, 'price_ghs': price})
        self.stdout.write(self.style.SUCCESS('Reach plans seeded.'))
