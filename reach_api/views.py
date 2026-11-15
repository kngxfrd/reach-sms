import json
import math
import os
import secrets
from datetime import timedelta
from django.contrib.auth import authenticate
from django.contrib.auth.models import User
from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone
from rest_framework import status
from rest_framework.authentication import TokenAuthentication
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.permissions import AllowAny, IsAdminUser
from rest_framework.response import Response
from rest_framework.authtoken.models import Token
from .models import Campaign, Contact, Draft, Plan, Purchase, SenderSubmission
from .serializers import CampaignSerializer, ContactSerializer, DraftSerializer, PlanSerializer, PurchaseSerializer, SenderSerializer, UserSerializer
from .services import fulfill_purchase, paystack_request, sailup_request, valid_signature, wallet_for


def auth_response(user, created=False):
    token, _ = Token.objects.get_or_create(user=user)
    return Response({'token': token.key, 'user': UserSerializer(user).data}, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


def segments(message):
    return max(1, math.ceil(len(str(message or '')) / 160))


@api_view(['GET'])
@permission_classes([AllowAny])
def health(request): return Response({'ok': True, 'service': 'reach-django-api'})


@api_view(['POST'])
@permission_classes([AllowAny])
def signup(request):
    name = str(request.data.get('name', '')).strip(); email = str(request.data.get('email', '')).strip().lower(); password = request.data.get('password', '')
    if not name or '@' not in email or not isinstance(password, str) or len(password) < 6: return Response({'error': 'Enter a valid name, email, and a password of at least 6 characters.'}, status.HTTP_400_BAD_REQUEST)
    if User.objects.filter(email__iexact=email).exists(): return Response({'error': 'An account with that email already exists.'}, status.HTTP_409_CONFLICT)
    first, *rest = name.split(' ')
    user = User.objects.create_user(username=email, email=email, password=password, first_name=first, last_name=' '.join(rest))
    wallet_for(user)
    return auth_response(user, True)


@api_view(['POST'])
@permission_classes([AllowAny])
def signin(request):
    email = str(request.data.get('email', '')).strip().lower(); password = request.data.get('password', '')
    try: account = User.objects.get(email__iexact=email)
    except User.DoesNotExist: account = None
    user = authenticate(request, username=account.username if account else email, password=password)
    if not user: return Response({'error': 'Email or password is incorrect.'}, status.HTTP_401_UNAUTHORIZED)
    wallet_for(user)
    return auth_response(user)


@api_view(['POST'])
@permission_classes([AllowAny])
def admin_signup(request):
    expected = os.getenv('ADMIN_SIGNUP_KEY', '')
    if not expected or request.headers.get('X-Admin-Signup-Key') != expected: return Response({'error': 'A valid admin signup key is required.'}, status.HTTP_403_FORBIDDEN)
    name = str(request.data.get('name', '')).strip(); email = str(request.data.get('email', '')).strip().lower(); password = request.data.get('password', '')
    if not name or '@' not in email or not isinstance(password, str) or len(password) < 8: return Response({'error': 'Name, email, and a password of at least 8 characters are required.'}, status.HTTP_400_BAD_REQUEST)
    if User.objects.filter(email__iexact=email).exists(): return Response({'error': 'An account with that email already exists.'}, status.HTTP_409_CONFLICT)
    first, *rest = name.split(' ')
    user = User.objects.create_superuser(username=email, email=email, password=password, first_name=first, last_name=' '.join(rest))
    wallet_for(user)
    return auth_response(user, True)


@api_view(['GET'])
def me(request):
    wallet = wallet_for(request.user)
    return Response({'user': UserSerializer(request.user).data, 'wallet': {'credits': wallet.credits, 'updatedAt': wallet.updated_at}})


@api_view(['GET'])
@permission_classes([AllowAny])
def plans(request): return Response({'plans': PlanSerializer(Plan.objects.order_by('credits'), many=True).data})


@api_view(['GET', 'POST'])
def senders(request):
    if request.method == 'GET': return Response({'senders': SenderSerializer(SenderSubmission.objects.filter(user=request.user).order_by('-id'), many=True).data})
    name = str(request.data.get('name', '')).strip(); use_case = request.data.get('useCase'); sample = str(request.data.get('sampleMessage', '')).strip(); notes = str(request.data.get('notes', '')).strip()[:500]
    import re
    if not re.fullmatch(r'(?=.{3,11}$)[A-Za-z0-9]+(?: [A-Za-z0-9]+)*', name): return Response({'error': 'Sender ID must be 3-11 characters using letters, numbers, and single spaces.'}, status.HTTP_400_BAD_REQUEST)
    if use_case not in ('transactional', 'promotional') or not sample or len(sample) > 500: return Response({'error': 'Choose a valid use case and add a sample message up to 500 characters.'}, status.HTTP_400_BAD_REQUEST)
    try: provider = sailup_request('/senders/', {'name': name, 'use_case': use_case, 'sample_message': sample, 'notes': notes})
    except Exception as exc: return Response({'error': str(exc)}, status.HTTP_502_BAD_GATEWAY)
    data = provider.get('data', provider); raw_status = str(data.get('status', 'pending')).lower(); state = 'active' if raw_status in ('active', 'approved') else 'rejected' if raw_status == 'rejected' else 'pending'
    sender = SenderSubmission.objects.create(user=request.user, provider_id=data.get('id'), name=name, use_case=use_case, sample_message=sample, notes=notes, status=state)
    return Response({'sender': SenderSerializer(sender).data}, status.HTTP_201_CREATED)


@api_view(['GET'])
def wallet(request):
    value = wallet_for(request.user); return Response({'credits': value.credits, 'updatedAt': value.updated_at})


@api_view(['GET'])
def purchases(request): return Response({'purchases': PurchaseSerializer(Purchase.objects.filter(user=request.user).order_by('-id')[:20], many=True).data})


@api_view(['POST'])
def payment_initialize(request):
    try: plan = Plan.objects.get(pk=request.data.get('planId'))
    except Plan.DoesNotExist: return Response({'error': 'Unknown credit plan.'}, status.HTTP_400_BAD_REQUEST)
    reference = f'reach_{request.user.id}_{int(timezone.now().timestamp()*1000)}_{secrets.token_hex(5)}'
    callback = os.getenv('PAYSTACK_CALLBACK_URL') or f"{os.getenv('APP_URL', 'http://localhost:5173')}/payment/callback"
    try: payment = paystack_request('/transaction/initialize', {'email': request.user.email, 'amount': int(plan.price_ghs * 100), 'currency': 'GHS', 'reference': reference, 'callback_url': callback, 'metadata': {'userId': request.user.id, 'planId': plan.id, 'credits': plan.credits}})
    except Exception as exc: return Response({'error': str(exc)}, status.HTTP_502_BAD_GATEWAY)
    Purchase.objects.create(user=request.user, plan=plan, reference=reference, credits=plan.credits, amount_ghs=plan.price_ghs)
    return Response({'authorizationUrl': payment['data']['authorization_url'], 'accessCode': payment['data'].get('access_code'), 'reference': reference}, status.HTTP_201_CREATED)


@api_view(['POST'])
def payment_verify(request):
    reference = request.data.get('reference')
    try: purchase = Purchase.objects.get(reference=reference, user=request.user)
    except Purchase.DoesNotExist: return Response({'error': 'Payment reference was not found.'}, status.HTTP_404_NOT_FOUND)
    try: verified = paystack_request(f'/transaction/verify/{reference}', method='GET')
    except Exception as exc: return Response({'error': str(exc)}, status.HTTP_502_BAD_GATEWAY)
    try: purchase = fulfill_purchase(reference, verified['data'])
    except Exception as exc: return Response({'error': str(exc)}, status.HTTP_400_BAD_REQUEST)
    return Response({'wallet': {'credits': wallet_for(request.user).credits}, 'purchase': PurchaseSerializer(purchase).data})


@api_view(['GET', 'POST'])
def drafts(request):
    if request.method == 'GET': return Response({'drafts': DraftSerializer(Draft.objects.filter(user=request.user).order_by('-id'), many=True).data})
    data = request.data.copy(); data['user'] = request.user.id
    draft_id = data.get('id')
    if draft_id:
        try: draft = Draft.objects.get(pk=draft_id, user=request.user)
        except Draft.DoesNotExist: return Response({'error': 'Draft not found.'}, status.HTTP_404_NOT_FOUND)
        serializer = DraftSerializer(draft, data=data, partial=True)
    else: serializer = DraftSerializer(data=data)
    if not serializer.is_valid(): return Response({'error': serializer.errors}, status.HTTP_400_BAD_REQUEST)
    draft = serializer.save(user=request.user)
    return Response({'draft': DraftSerializer(draft).data}, status.HTTP_200_OK if draft_id else status.HTTP_201_CREATED)


@api_view(['DELETE'])
def draft_detail(request, pk):
    deleted, _ = Draft.objects.filter(pk=pk, user=request.user).delete()
    return Response({'deleted': True}) if deleted else Response({'error': 'Draft not found.'}, status.HTTP_404_NOT_FOUND)


@api_view(['GET', 'POST'])
def contacts(request):
    if request.method == 'GET': return Response({'contacts': ContactSerializer(Contact.objects.filter(user=request.user).order_by('-id'), many=True).data})
    serializer = ContactSerializer(data=request.data)
    if not serializer.is_valid(): return Response({'error': serializer.errors}, status.HTTP_400_BAD_REQUEST)
    return Response({'contact': ContactSerializer(serializer.save(user=request.user)).data}, status.HTTP_201_CREATED)


@api_view(['PUT', 'DELETE'])
def contact_detail(request, pk):
    try: contact = Contact.objects.get(pk=pk, user=request.user)
    except Contact.DoesNotExist: return Response({'error': 'Contact not found.'}, status.HTTP_404_NOT_FOUND)
    if request.method == 'DELETE': contact.delete(); return Response({'deleted': True})
    serializer = ContactSerializer(contact, data=request.data, partial=True)
    if not serializer.is_valid(): return Response({'error': serializer.errors}, status.HTTP_400_BAD_REQUEST)
    return Response({'contact': ContactSerializer(serializer.save()).data})


@api_view(['GET', 'POST'])
def campaigns(request):
    if request.method == 'GET': return Response({'campaigns': CampaignSerializer(Campaign.objects.filter(user=request.user).order_by('-id')[:50], many=True).data})
    name = str(request.data.get('name', '')).strip(); message = str(request.data.get('message', '')); numbers = request.data.get('recipientNumbers', []); count = int(request.data.get('recipients', len(numbers)) or 0)
    if not name or not message or count < 1 or not isinstance(numbers, list) or len(numbers) != count: return Response({'error': 'Campaign name, message, and matching recipient numbers are required.'}, status.HTTP_400_BAD_REQUEST)
    required = count * segments(message)
    sender_id = request.data.get('senderId')
    sender = SenderSubmission.objects.filter(user=request.user, status='active', pk=sender_id).first() if sender_id else SenderSubmission.objects.filter(user=request.user, status='active').order_by('-id').first()
    if not sender: return Response({'error': 'Register a sender ID and wait for Sailup approval before sending campaigns.'}, status.HTTP_409_CONFLICT)
    scheduled_for = request.data.get('scheduledFor')
    wallet = wallet_for(request.user)
    with transaction.atomic():
        wallet = wallet_for(request.user)
        if wallet.credits < required: return Response({'error': f'You need {required} credits but only have {wallet.credits}.'}, status.HTTP_402_PAYMENT_REQUIRED)
        wallet.credits -= required; wallet.save(update_fields=['credits', 'updated_at'])
        scheduled = bool(scheduled_for and timezone.datetime.fromisoformat(scheduled_for.replace('Z', '+00:00')) > timezone.now())
        campaign = Campaign.objects.create(user=request.user, name=name, audience=request.data.get('audience', 'Contacts'), message=message, recipients=count, recipient_numbers=numbers, credits_used=required, status='Scheduled' if scheduled else 'Sending', scheduled_for=scheduled_for, sender=sender)
    if scheduled: return Response({'wallet': {'credits': wallet.credits}, 'campaign': CampaignSerializer(campaign).data}, status.HTTP_201_CREATED)
    try: provider = sailup_request('/sms/', {'from': sender.name, 'to': numbers, 'body': message})
    except Exception as exc:
        wallet.credits += required; wallet.save(update_fields=['credits', 'updated_at']); campaign.status = 'Failed'; campaign.save(update_fields=['status']); return Response({'error': f'SMS was not accepted by Sailup: {exc}'}, status.HTTP_502_BAD_GATEWAY)
    campaign.status = 'Queued'; campaign.provider_message_ids = [item.get('id') for item in provider.get('messages', []) if item.get('id')]; campaign.save(update_fields=['status', 'provider_message_ids'])
    return Response({'wallet': {'credits': wallet.credits}, 'campaign': CampaignSerializer(campaign).data}, status.HTTP_201_CREATED)


@api_view(['GET'])
@permission_classes([IsAdminUser])
def admin_stats(request):
    return Response({'users': User.objects.count(), 'contacts': Contact.objects.count(), 'campaigns': Campaign.objects.count(), 'messagesSent': Campaign.objects.filter(status__in=['Queued', 'Delivered']).aggregate(total=Sum('recipients'))['total'] or 0, 'creditsUsed': Campaign.objects.aggregate(total=Sum('credits_used'))['total'] or 0, 'revenueGhs': Purchase.objects.filter(status='paid').aggregate(total=Sum('amount_ghs'))['total'] or 0})


@api_view(['POST'])
@permission_classes([AllowAny])
def sailup_webhook(request):
    raw = request.body
    if not valid_signature(raw, request.headers.get('X-Sailup-Signature', ''), os.getenv('SAILUP_WEBHOOK_SECRET', '')): return Response({'error': 'Invalid Sailup webhook signature.'}, status.HTTP_401_UNAUTHORIZED)
    event = request.data; data = event.get('data', {}); sender_data = data.get('sender', data); provider_id = sender_data.get('id') or sender_data.get('sender_id'); event_name = str(event.get('event', event.get('type', ''))).lower()
    state = 'active' if 'approved' in event_name else 'rejected' if 'rejected' in event_name else str(sender_data.get('status', '')).lower()
    if provider_id and state in ('active', 'approved', 'rejected', 'pending', 'review'): SenderSubmission.objects.filter(provider_id=provider_id).update(status='active' if state in ('active', 'approved') else state)
    return Response({'received': True})
