from django.contrib.auth.models import User
from django.db import models


class Wallet(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='wallet')
    credits = models.PositiveIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)


class Plan(models.Model):
    id = models.CharField(max_length=40, primary_key=True)
    name = models.CharField(max_length=80)
    credits = models.PositiveIntegerField()
    price_ghs = models.DecimalField(max_digits=12, decimal_places=2)


class Contact(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='contacts')
    first_name = models.CharField(max_length=100)
    last_name = models.CharField(max_length=100, blank=True)
    phone = models.CharField(max_length=40)
    consent = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)


class SenderSubmission(models.Model):
    STATUS_CHOICES = [('pending', 'Pending'), ('active', 'Approved'), ('rejected', 'Rejected')]
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='sender_submissions')
    provider_id = models.CharField(max_length=120, blank=True, null=True)
    name = models.CharField(max_length=11)
    use_case = models.CharField(max_length=30)
    sample_message = models.TextField(max_length=500)
    notes = models.TextField(max_length=500, blank=True)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    created_at = models.DateTimeField(auto_now_add=True)


class Purchase(models.Model):
    STATUS_CHOICES = [('pending', 'Pending'), ('paid', 'Paid'), ('failed', 'Failed')]
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='purchases')
    plan = models.ForeignKey(Plan, on_delete=models.PROTECT)
    reference = models.CharField(max_length=160, unique=True)
    credits = models.PositiveIntegerField()
    amount_ghs = models.DecimalField(max_digits=12, decimal_places=2)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='pending')
    gateway = models.CharField(max_length=30, default='paystack')
    created_at = models.DateTimeField(auto_now_add=True)


class Draft(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='drafts')
    name = models.CharField(max_length=160, default='Untitled campaign')
    audience = models.CharField(max_length=160, default='Manual recipients')
    message = models.TextField(blank=True)
    recipient_numbers = models.JSONField(default=list)
    sender = models.ForeignKey(SenderSubmission, on_delete=models.SET_NULL, null=True, blank=True)
    scheduled_for = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class Campaign(models.Model):
    STATUS_CHOICES = [('Sending', 'Sending'), ('Queued', 'Queued'), ('Scheduled', 'Scheduled'), ('Delivered', 'Delivered'), ('Failed', 'Failed'), ('Rejected', 'Rejected')]
    user = models.ForeignKey(User, on_delete=models.CASCADE, related_name='campaigns')
    name = models.CharField(max_length=160)
    audience = models.CharField(max_length=160, default='Contacts')
    message = models.TextField()
    recipients = models.PositiveIntegerField()
    recipient_numbers = models.JSONField(default=list)
    credits_used = models.PositiveIntegerField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='Sending')
    provider = models.CharField(max_length=40, default='sailup')
    provider_message_ids = models.JSONField(default=list)
    scheduled_for = models.DateTimeField(null=True, blank=True)
    sender = models.ForeignKey(SenderSubmission, on_delete=models.SET_NULL, null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
