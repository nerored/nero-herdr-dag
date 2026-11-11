import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = await mkdtemp(join(root, '.dist-stage-'));
try {
  await cp(join(root, 'src'), join(stage, 'src'), { recursive: true });
  await cp(join(root, 'extension.mjs'), join(stage, 'extension.mjs'));
  await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  await mkdir(join(stage, 'scripts'));
  await cp(join(root, 'scripts', 'install.mjs'), join(stage, 'scripts', 'install.mjs'));
  await cp(join(root, 'scripts', 'install-lib.mjs'), join(stage, 'scripts', 'install-lib.mjs'));
  await cp(join(root, 'scripts', 'uninstall.mjs'), join(stage, 'scripts', 'uninstall.mjs'));
  const transpiler = typeof Bun !== 'undefined' ? new Bun.Transpiler({ loader: 'js' }) : null;
  const checkSyntax = async file => {
    if (transpiler) transpiler.transformSync(await readFile(file, 'utf8'));
    else execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  };
  const files = await readdir(stage, { recursive: true });
  for (const file of files.filter(name => name.endsWith('.mjs'))) {
    await checkSyntax(join(stage, file));
  }
  await checkSyntax(join(root, 'bin', 'dag-studio.mjs'));
  await rm(join(root, 'dist'), { recursive: true, force: true });
  await rename(stage, join(root, 'dist'));
  console.log('Built dist/: extension, viewer, controller, and installer. Syntax checks passed.');
} finally {
  await rm(stage, { recursive: true, force: true });
}
