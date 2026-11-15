from pathlib import Path
import os
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
SECRET_KEY = os.getenv('DJANGO_SECRET_KEY', 'dev-only-change-me')
DEBUG = os.getenv('DJANGO_DEBUG', 'false').lower() == 'true'
allowed_hosts = os.getenv('DJANGO_ALLOWED_HOSTS', '*')
render_host = os.getenv('RENDER_EXTERNAL_HOSTNAME')
ALLOWED_HOSTS = [host.strip() for host in allowed_hosts.split(',') if host.strip()]
if render_host and render_host not in ALLOWED_HOSTS: ALLOWED_HOSTS.append(render_host)

INSTALLED_APPS = [
    'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
    'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles',
    'rest_framework', 'rest_framework.authtoken', 'drf_spectacular', 'corsheaders',
    'reach_api',
]
MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware', 'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware', 'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware', 'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware', 'django.middleware.clickjacking.XFrameOptionsMiddleware',
]
ROOT_URLCONF = 'reach_backend.urls'
TEMPLATES = [{
    'BACKEND': 'django.template.backends.django.DjangoTemplates',
    'DIRS': [], 'APP_DIRS': True,
    'OPTIONS': {'context_processors': [
        'django.template.context_processors.request', 'django.contrib.auth.context_processors.auth',
        'django.contrib.messages.context_processors.messages',
    ]},
}]
WSGI_APPLICATION = 'reach_backend.wsgi.application'

DATABASE_URL = os.getenv('DATABASE_URL')
DATABASES = {'default': dj_database_url.config(default=DATABASE_URL or f"sqlite:///{os.getenv('DJANGO_DB_PATH', str(BASE_DIR / 'data' / 'reach-django.sqlite3'))}", conn_max_age=600, ssl_require=bool(DATABASE_URL and not DEBUG))}
AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
]
LANGUAGE_CODE = 'en-us'
TIME_ZONE = os.getenv('DJANGO_TIME_ZONE', 'UTC')
USE_I18N = True
USE_TZ = True
STATIC_URL = 'static/'
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
CORS_ALLOW_ALL_ORIGINS = os.getenv('CORS_ALLOW_ALL_ORIGINS', 'false').lower() == 'true'
CORS_ALLOWED_ORIGINS = [origin.strip() for origin in os.getenv('CORS_ALLOWED_ORIGINS', '').split(',') if origin.strip()]
CSRF_TRUSTED_ORIGINS = [origin.strip() for origin in os.getenv('CSRF_TRUSTED_ORIGINS', '').split(',') if origin.strip()]
STATIC_ROOT = BASE_DIR / 'staticfiles'
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': ['reach_api.authentication.BearerTokenAuthentication'],
    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
    'DEFAULT_SCHEMA_CLASS': 'drf_spectacular.openapi.AutoSchema',
}
AUTHENTICATION_BACKENDS = ['reach_api.auth_backends.LegacyNodeScryptBackend', 'django.contrib.auth.backends.ModelBackend']
SPECTACULAR_SETTINGS = {
    'TITLE': 'Reach SMS API', 'DESCRIPTION': 'Bulk SMS, contacts, campaigns, credits, sender IDs, and admin metrics.',
    'VERSION': '1.0.0', 'SERVE_INCLUDE_SCHEMA': False,
}
PAYSTACK_SECRET_KEY = os.getenv('PAYSTACK_SECRET_KEY', '')
PAYSTACK_CALLBACK_URL = os.getenv('PAYSTACK_CALLBACK_URL', '')
SAILUP_API_KEY = os.getenv('SAILUP_API_KEY', '')
SAILUP_API_URL = os.getenv('SAILUP_API_URL', 'https://api.sailup.io/v1').rstrip('/')
SAILUP_WEBHOOK_SECRET = os.getenv('SAILUP_WEBHOOK_SECRET', '')
PAYSTACK_WEBHOOK_SECRET = os.getenv('PAYSTACK_WEBHOOK_SECRET', '')
