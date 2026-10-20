"""Build a local distribution without including credentials, caches or test outputs."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
dist = root / 'dist'
dist.mkdir(exist_ok=True)
extension_files = sorted((root / 'extension').rglob('*'))
with ZipFile(dist / 'alef-assistant.zip', 'w', ZIP_DEFLATED) as archive:
    for file in extension_files:
        if file.is_file():
            archive.write(file, file.relative_to(root / 'extension'))
with ZipFile(dist / 'alef-assistant-project.zip', 'w', ZIP_DEFLATED) as archive:
    for folder in ['extension', 'server', 'scripts', 'docs', 'test']:
        for file in sorted((root / folder).rglob('*')):
            if file.is_file():
                archive.write(file, Path('alef-assistant') / file.relative_to(root))
    for name in ['package.json', 'package-lock.json', '.env.example', '.gitignore', 'README.md', 'START-WINDOWS.cmd']:
        file = root / name
        if file.exists():
            archive.write(file, Path('alef-assistant') / name)
print('Built dist/alef-assistant.zip and dist/alef-assistant-project.zip')
