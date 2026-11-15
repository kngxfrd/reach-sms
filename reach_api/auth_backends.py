import hashlib
import hmac
from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend


class LegacyNodeScryptBackend(ModelBackend):
    """Accept hashes written by the previous Node backend and upgrade them."""
    def authenticate(self, request, username=None, password=None, **kwargs):
        User = get_user_model()
        try: user = User.objects.get(username=username)
        except User.DoesNotExist: return None
        stored = user.password or ''
        if ':' not in stored or not password: return super().authenticate(request, username=username, password=password, **kwargs)
        salt, expected_hex = stored.split(':', 1)
        if len(expected_hex) != 128: return None
        try: actual = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64).hex()
        except (ValueError, TypeError): return None
        if not hmac.compare_digest(actual, expected_hex): return None
        user.set_password(password); user.save(update_fields=['password']); return user
