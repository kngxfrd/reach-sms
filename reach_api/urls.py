from django.urls import path
from . import views

urlpatterns = [
    path('health', views.health),
    path('auth/signup', views.signup),
    path('auth/signin', views.signin),
    path('auth/admin-signup', views.admin_signup),
    path('me', views.me),
    path('plans', views.plans),
    path('senders', views.senders),
    path('wallet', views.wallet),
    path('purchases', views.purchases),
    path('payments/initialize', views.payment_initialize),
    path('payments/verify', views.payment_verify),
    path('drafts', views.drafts),
    path('drafts/<int:pk>', views.draft_detail),
    path('contacts', views.contacts),
    path('contacts/<int:pk>', views.contact_detail),
    path('campaigns', views.campaigns),
    path('admin/stats', views.admin_stats),
    path('webhooks/sailup', views.sailup_webhook),
]
