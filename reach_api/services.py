import hashlib
import hmac
import os
import secrets
import requests
from django.conf import settings
from django.db import transaction
from django.utils import timezone
from .models import Purchase, Wallet


def wallet_for(user):
    wallet, _ = Wallet.objects.get_or_create(user=user)
    return wallet


def sailup_request(path, payload):
    if not settings.SAILUP_API_KEY:
        raise RuntimeError('Sailup is not configured. Set SAILUP_API_KEY on the Django server.')
    response = requests.post(f'{settings.SAILUP_API_URL}{path}', json=payload, headers={'Authorization': f'Bearer {settings.SAILUP_API_KEY}', 'Accept': 'application/json'}, timeout=15)
    data = response.json() if response.content else {}
    if not response.ok or data.get('error'):
        raise RuntimeError(data.get('message') or data.get('detail') or data.get('error') or f'Sailup returned HTTP {response.status_code}.')
    return data


def paystack_request(path, payload=None, method='POST'):
    if not settings.PAYSTACK_SECRET_KEY:
        raise RuntimeError('Paystack is not configured. Set PAYSTACK_SECRET_KEY on the Django server.')
    request_kwargs = {'headers': {'Authorization': f'Bearer {settings.PAYSTACK_SECRET_KEY}'}, 'timeout': 20}
    if method != 'GET': request_kwargs['json'] = payload or {}
    response = requests.request(method, f'https://api.paystack.co{path}', **request_kwargs)
    data = response.json() if response.content else {}
    if not response.ok or data.get('status') is False:
        raise RuntimeError(data.get('message') or f'Paystack returned HTTP {response.status_code}.')
    return data


def fulfill_purchase(reference, verified):
    purchase = Purchase.objects.select_related('user').get(reference=reference)
    if purchase.status == 'paid': return purchase
    expected = int(purchase.amount_ghs * 100)
    if verified.get('status') != 'success' or int(verified.get('amount', 0)) != expected or verified.get('currency') != 'GHS':
        raise RuntimeError('Paystack payment verification failed.')
    with transaction.atomic():
        purchase.status = 'paid'; purchase.gateway = 'paystack'; purchase.save(update_fields=['status', 'gateway'])
        wallet = wallet_for(purchase.user)
        wallet.credits += purchase.credits; wallet.save(update_fields=['credits', 'updated_at'])
    return purchase


def valid_signature(raw, signature, secret):
    if not signature or not secret: return False
    signature = signature.replace('sha256=', '')
    expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, expected)
