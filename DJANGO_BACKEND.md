# Reach Django backend

The canonical backend is now Django + Django REST Framework. The existing React app keeps the same `/api/...` paths and sends its bearer token to Django.

## Local setup

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python manage.py migrate
python manage.py seed_plans
python manage.py import_node_sqlite --source data/reach.sqlite
python manage.py runserver 8000
```

Run the frontend separately with `npm run dev`. Vite proxies `/api` to `http://localhost:8000` by default. Override it with `VITE_API_URL` if Django runs elsewhere.

Swagger is available at `http://localhost:8000/api/docs/` and the OpenAPI schema is at `http://localhost:8000/api/schema/`. Django admin is at `http://localhost:8000/admin/`.

## Admin access

Set `ADMIN_SIGNUP_KEY` in the Django environment, then call `POST /api/auth/admin-signup` with the same JSON fields as signup and an `X-Admin-Signup-Key` header. This creates a Django superuser. Admin metrics are available to that account at `GET /api/admin/stats`.

## Environment

Copy the existing provider keys into the Django environment: `DJANGO_SECRET_KEY`, `DJANGO_ALLOWED_HOSTS`, `DJANGO_DB_PATH`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_CALLBACK_URL`, `SAILUP_API_KEY`, `SAILUP_API_URL`, `SAILUP_WEBHOOK_SECRET`, `PAYSTACK_WEBHOOK_SECRET`, and `ADMIN_SIGNUP_KEY`.

SMS billing is calculated server-side as `recipient_count * ceil(message_length / 160)`. A 480-character message uses 3 credits per recipient; 481 characters uses 4.
