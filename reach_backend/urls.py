from django.contrib import admin
from django.urls import include, path, re_path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView
from .frontend import frontend_asset, frontend_index

urlpatterns = [
    path('admin/', admin.site.urls),
    path('api/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('api/docs/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
    path('api/', include('reach_api.urls')),
    re_path(r'^assets/(?P<path>.*)$', frontend_asset),
    re_path(r'^(?!api/|admin/|static/|assets/).*$' , frontend_index),
]
