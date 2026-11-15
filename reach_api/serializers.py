from django.contrib.auth.models import User
from rest_framework import serializers
from .models import Campaign, Contact, Draft, Plan, Purchase, SenderSubmission


class UserSerializer(serializers.ModelSerializer):
    class Meta:
        model = User
        fields = ('id', 'first_name', 'last_name', 'email', 'username')

    def to_representation(self, instance):
        data = super().to_representation(instance)
        data['name'] = instance.get_full_name() or instance.username
        data.pop('first_name', None); data.pop('last_name', None); data.pop('username', None)
        return data


class PlanSerializer(serializers.ModelSerializer):
    priceGhs = serializers.FloatField(source='price_ghs')
    class Meta:
        model = Plan
        fields = ('id', 'name', 'credits', 'priceGhs')


class ContactSerializer(serializers.ModelSerializer):
    firstName = serializers.CharField(source='first_name')
    lastName = serializers.CharField(source='last_name', required=False, allow_blank=True)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)
    class Meta:
        model = Contact
        fields = ('id', 'firstName', 'lastName', 'phone', 'consent', 'createdAt')


class SenderSerializer(serializers.ModelSerializer):
    providerId = serializers.CharField(source='provider_id', read_only=True)
    useCase = serializers.CharField(source='use_case')
    sampleMessage = serializers.CharField(source='sample_message')
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)
    class Meta:
        model = SenderSubmission
        fields = ('id', 'providerId', 'name', 'useCase', 'sampleMessage', 'notes', 'status', 'createdAt')


class DraftSerializer(serializers.ModelSerializer):
    recipientNumbers = serializers.JSONField(source='recipient_numbers')
    senderId = serializers.PrimaryKeyRelatedField(source='sender', queryset=SenderSubmission.objects.all(), required=False, allow_null=True)
    scheduledFor = serializers.DateTimeField(source='scheduled_for', allow_null=True, required=False)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)
    updatedAt = serializers.DateTimeField(source='updated_at', read_only=True)
    class Meta:
        model = Draft
        fields = ('id', 'name', 'audience', 'message', 'recipientNumbers', 'senderId', 'scheduledFor', 'createdAt', 'updatedAt')


class CampaignSerializer(serializers.ModelSerializer):
    creditsUsed = serializers.IntegerField(source='credits_used')
    scheduledFor = serializers.DateTimeField(source='scheduled_for', allow_null=True, read_only=True)
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)
    class Meta:
        model = Campaign
        fields = ('id', 'name', 'audience', 'message', 'recipients', 'creditsUsed', 'status', 'scheduledFor', 'createdAt')


class PurchaseSerializer(serializers.ModelSerializer):
    planId = serializers.CharField(source='plan_id')
    amountGhs = serializers.FloatField(source='amount_ghs')
    createdAt = serializers.DateTimeField(source='created_at', read_only=True)
    class Meta:
        model = Purchase
        fields = ('id', 'planId', 'reference', 'credits', 'amountGhs', 'status', 'gateway', 'createdAt')
