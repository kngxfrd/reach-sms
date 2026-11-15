from pathlib import Path
from django.http import FileResponse, Http404

BASE_DIR = Path(__file__).resolve().parent.parent
DIST_DIR = BASE_DIR / 'dist'


def frontend_asset(request, path):
    file_path = DIST_DIR / path
    if not file_path.is_file(): raise Http404
    return FileResponse(file_path.open('rb'))


def frontend_index(request):
    index = DIST_DIR / 'index.html'
    if not index.is_file(): raise Http404
    return FileResponse(index.open('rb'), content_type='text/html')
