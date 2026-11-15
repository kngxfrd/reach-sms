from django.contrib import admin
from .models import Campaign, Contact, Draft, Plan, Purchase, SenderSubmission, Wallet

for model in (Wallet, Plan, Contact, SenderSubmission, Purchase, Draft, Campaign):
    admin.site.register(model)
