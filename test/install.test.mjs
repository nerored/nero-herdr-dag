import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generationName, mkdirExclusive, pruneGenerations, verifyManagedContainer, writeFileNoFollow,
} from '../scripts/install-lib.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const scripts = join(repo, 'scripts');
const cli = join(repo, 'bin', 'dag-studio.mjs');
const marker = '// managed by herdr-dag-studio';
const wrapperName = 'omo-herdr-dag-studio.js';
const demoSnapshot = join(repo, 'demo', 'snapshot.json');
const demoAt = 1_762_775_000_000;

async function temporaryDir(t, prefix = 'herdr-dag-safety-') {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function runNode(args, { env = {} } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }));
  });
}

function runScript(script, args, env) {
  return runNode([join(scripts, script), ...args], { env });
}

async function waitFor(check, { timeout = 5000, interval = 25, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function pidsMatching(pattern) {
  return new Promise(resolvePids => {
    const child = spawn('pgrep', ['-f', pattern], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('close', () => {
      resolvePids(stdout.split('\n').filter(line => /^\d+$/.test(line.trim())).map(Number));
    });
  });
}

async function symlinkedFixture(t, { link = 'container' } = {}) {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const victim = join(base, 'victim');
  await mkdir(join(agent, 'extensions'), { recursive: true });
  await mkdir(join(victim, 'integration'), { recursive: true });
  await writeFile(join(victim, 'integration', '.installed-by'), marker);
  await writeFile(join(victim, 'integration', 'important.txt'), 'keep me');
  await writeFile(join(agent, 'extensions', wrapperName), `${marker}\nexport default 1;\n`);
  if (link === 'container') {
    await symlink(victim, join(agent, 'herdr-dag-studio'));
  } else if (link === 'integration') {
    await mkdir(join(agent, 'herdr-dag-studio'));
    await symlink(join(victim, 'integration'), join(agent, 'herdr-dag-studio', 'integration'));
  } else if (link === 'wrapper') {
    await writeFile(join(victim, 'extension.js'), `${marker}\nexport default 1;\n`);
    await rm(join(agent, 'extensions', wrapperName));
    await symlink(join(victim, 'extension.js'), join(agent, 'extensions', wrapperName));
  }
  return {
    base,
    agent,
    victim,
    wrapper: join(agent, 'extensions', wrapperName),
    container: join(agent, 'herdr-dag-studio', 'integration'),
  };
}

test('uninstall refuses a symlinked container and preserves the victim', { timeout: 30000 }, async t => {
  const fixture = await symlinkedFixture(t);
  const result = await runScript('uninstall.mjs', ['--agent-dir', fixture.agent]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink/i);
  assert.equal(await readFile(join(fixture.victim, 'integration', 'important.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(join(fixture.victim, 'integration', '.installed-by'), 'utf8'), marker);
  assert.deepEqual((await readdir(join(fixture.victim, 'integration'))).sort(), ['.installed-by', 'important.txt']);
  assert.equal(await readFile(fixture.wrapper, 'utf8'), `${marker}\nexport default 1;\n`);
});

test('install refuses a symlinked container and writes nothing into the victim', { timeout: 30000 }, async t => {
  const fixture = await symlinkedFixture(t);
  const before = (await readdir(join(fixture.victim, 'integration'))).sort();
  const result = await runScript('install.mjs', ['--agent-dir', fixture.agent]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink/i);
  assert.deepEqual((await readdir(join(fixture.victim, 'integration'))).sort(), before);
  assert.equal(await readFile(join(fixture.victim, 'integration', 'important.txt'), 'utf8'), 'keep me');
  assert.equal(await readFile(fixture.wrapper, 'utf8'), `${marker}\nexport default 1;\n`);
});

test('uninstall refuses a symlinked integration directory', { timeout: 30000 }, async t => {
  const fixture = await symlinkedFixture(t, { link: 'integration' });
  const result = await runScript('uninstall.mjs', ['--agent-dir', fixture.agent]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /symlink/i);
  assert.equal(await readFile(join(fixture.victim, 'integration', 'important.txt'), 'utf8'), 'keep me');
  assert.equal(await exists(fixture.container), true);
});

test('uninstall and install refuse a symlinked wrapper file', { timeout: 30000 }, async t => {
  const fixture = await symlinkedFixture(t, { link: 'wrapper' });
  for (const script of ['uninstall.mjs', 'install.mjs']) {
    const result = await runScript(script, ['--agent-dir', fixture.agent]);
    assert.notEqual(result.code, 0, script);
    assert.match(result.stderr, /symlink/i, script);
    assert.equal(await readFile(join(fixture.victim, 'extension.js'), 'utf8'), `${marker}\nexport default 1;\n`, script);
  }
});

test('uninstall keeps a container that is not marked as managed', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const container = join(agent, 'herdr-dag-studio', 'integration');
  await mkdir(container, { recursive: true });
  await mkdir(join(agent, 'extensions'), { recursive: true });
  await writeFile(join(container, 'user-data.json'), '{}');
  await writeFile(join(agent, 'extensions', wrapperName), `${marker}\nexport default 1;\n`);

  const result = await runScript('uninstall.mjs', ['--agent-dir', agent]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /not managed by herdr-dag-studio/i);
  assert.equal(await readFile(join(container, 'user-data.json'), 'utf8'), '{}');
});

test('a normal install and uninstall touch only the managed tree', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const wrapper = join(agent, 'extensions', wrapperName);
  const container = join(agent, 'herdr-dag-studio', 'integration');

  const installed = await runScript('install.mjs', ['--agent-dir', agent]);
  assert.equal(installed.code, 0);
  const plan = JSON.parse(installed.stdout);
  assert.equal(plan.installed, true);
  assert.equal(plan.agentDir, resolve(agent));
  assert.match(await readFile(wrapper, 'utf8'), /^\/\/ managed by herdr-dag-studio\n/);
  const generations = (await readdir(container)).filter(name => name.startsWith('generation-'));
  assert.deepEqual(generations, ['generation-000001']);

  const removed = await runScript('uninstall.mjs', ['--agent-dir', agent]);
  assert.equal(removed.code, 0);
  assert.equal(await exists(wrapper), false);
  assert.equal(await exists(container), false);
  assert.equal(await exists(join(agent, 'extensions')), true);
});

test('dry runs are side-effect free for both scripts', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'absent-agent');

  const installed = await runScript('install.mjs', ['--dry-run', '--agent-dir', agent]);
  assert.equal(installed.code, 0);
  assert.equal(JSON.parse(installed.stdout).agentDir, resolve(agent));
  assert.equal(await exists(agent), false);

  const uninstallPlan = await runScript('uninstall.mjs', ['--dry-run', '--agent-dir', agent]);
  assert.equal(uninstallPlan.code, 0);
  assert.equal(JSON.parse(uninstallPlan.stdout).installed, false);
  assert.equal(await exists(agent), false);
});

test('--agent-dir requires a value in both forms for both scripts', { timeout: 30000 }, async t => {
  for (const script of ['install.mjs', 'uninstall.mjs']) {
    for (const args of [['--dry-run', '--agent-dir'], ['--dry-run', '--agent-dir='], ['--agent-dir=', '--dry-run']]) {
      const result = await runScript(script, args);
      assert.notEqual(result.code, 0, `${script} ${args.join(' ')}`);
      assert.match(result.stderr, /--agent-dir requires a value/, `${script} ${args.join(' ')}`);
    }
  }
});

test('a following flag is never consumed as the agent path', { timeout: 30000 }, async t => {
  const result = await runScript('install.mjs', ['--dry-run', '--agent-dir', '--dry-run']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /--agent-dir requires a value/);
});

test('unknown flags are rejected by both scripts', { timeout: 30000 }, async t => {
  for (const script of ['install.mjs', 'uninstall.mjs']) {
    const result = await runScript(script, ['--dry-run', '--bogus']);
    assert.notEqual(result.code, 0, script);
    assert.match(result.stderr, /Unknown option: --bogus/, script);
  }
});

test('--agent-dir=PATH is honored and expanded', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const target = join(base, 'equals-agent');
  const result = await runScript('install.mjs', ['--dry-run', `--agent-dir=${target}`]);
  assert.equal(result.code, 0);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.agentDir, resolve(target));
  assert.equal(plan.integration, join(resolve(target), 'herdr-dag-studio', 'integration', 'generation-000001'));
  assert.equal(await exists(target), false);

  const homeTarget = join(homedir(), 'dag-studio-parser-probe');
  const home = await runScript('install.mjs', ['--dry-run', '--agent-dir', '~/dag-studio-parser-probe']);
  assert.equal(home.code, 0);
  assert.equal(JSON.parse(home.stdout).agentDir, resolve(homeTarget));
});

test('the CLI signal probe leaves no orphan for SIGINT, SIGTERM, and SIGHUP', { timeout: 30000 }, async t => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    await t.test(signal, async t2 => {
      const dir = await temporaryDir(t2);
      const state = join(dir, 'state.json');
      const ready = join(dir, 'ready');
      const probe = join(dir, 'probe');
      const fakeViewer = join(dir, 'fake-viewer.mjs');
      await writeFile(state, JSON.stringify({
        version: 2, sessionId: 'signal-probe', connected: true, updatedAt: '2026-11-10T00:00:00Z', runs: [], tasks: [],
      }));
      await writeFile(fakeViewer, `import { writeFileSync } from 'node:fs';
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => { writeFileSync(process.env.DAG_STUDIO_PROBE, signal); process.exit(0); });
}
writeFileSync(process.env.DAG_STUDIO_READY, 'ready');
setInterval(() => {}, 1000);
`);

      const child = spawn(process.execPath, [cli, 'view', '--state', state], {
        cwd: repo,
        env: { ...process.env, DAG_STUDIO_VIEWER: fakeViewer, DAG_STUDIO_READY: ready, DAG_STUDIO_PROBE: probe },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let exited = false;
      t2.after(() => { if (!exited) child.kill('SIGKILL'); });

      await waitFor(() => existsSync(ready), { message: 'the viewer child to start' });
      assert.ok((await pidsMatching(state)).length >= 2, 'the CLI and viewer should both be alive');

      child.kill(signal);
      await new Promise((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error(`the CLI did not exit after ${signal}`)), 5000);
        child.on('exit', () => { exited = true; clearTimeout(timer); resolveExit(); });
      });
      await waitFor(() => existsSync(probe), { message: `the viewer to receive ${signal}` });
      assert.equal(await readFile(probe, 'utf8'), signal);
      await waitFor(async () => (await pidsMatching(state)).length === 0, { message: 'the viewer process to disappear' });
    });
  }
});

// F-166: second successful install, generation numbering, pointer, wrapper.
test('a second install publishes a new generation and keeps the previous one', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const container = join(agent, 'herdr-dag-studio', 'integration');
  const wrapper = join(agent, 'extensions', wrapperName);

  const first = await runScript('install.mjs', ['--agent-dir', agent]);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).installed, true);

  const second = await runScript('install.mjs', ['--agent-dir', agent]);
  assert.equal(second.code, 0, second.stderr);
  const plan = JSON.parse(second.stdout);
  assert.equal(plan.integration, join(container, 'generation-000002'));
  assert.equal(plan.backup, join(container, 'generation-000001'));
  assert.deepEqual(
    (await readdir(container)).filter(name => name.startsWith('generation-')).sort(),
    ['generation-000001', 'generation-000002'],
  );
  assert.deepEqual(JSON.parse(await readFile(join(container, 'current.json'), 'utf8')), {
    generation: 'generation-000002',
  });
  const wrapperText = await readFile(wrapper, 'utf8');
  assert.match(wrapperText, /^\/\/ managed by herdr-dag-studio\n/);
  assert.match(wrapperText, /integration\/generation-000002\/extension\.mjs/);
  assert.equal(await exists(join(container, 'generation-000001', 'extension.mjs')), true);
});

// F-177: current.json is consumed to bound retained generations.
test('--keep-generations bounds retained generations and keeps current.json valid', { timeout: 60000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const container = join(agent, 'herdr-dag-studio', 'integration');
  const wrapper = join(agent, 'extensions', wrapperName);

  for (let index = 0; index < 4; index++) {
    const result = await runScript('install.mjs', ['--agent-dir', agent, '--keep-generations', '2']);
    assert.equal(result.code, 0, result.stderr);
  }

  const generations = (await readdir(container)).filter(name => name.startsWith('generation-')).sort();
  assert.deepEqual(generations, ['generation-000003', 'generation-000004']);
  assert.deepEqual(JSON.parse(await readFile(join(container, 'current.json'), 'utf8')), {
    generation: 'generation-000004',
  });
  assert.match(await readFile(wrapper, 'utf8'), /integration\/generation-000004\/extension\.mjs/);

  const dry = await runScript('install.mjs', ['--dry-run', '--agent-dir', agent, '--keep-generations', '2']);
  assert.equal(dry.code, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.deepEqual(plan.retained, ['generation-000004', 'generation-000005']);
  assert.deepEqual(
    (await readdir(container)).filter(name => name.startsWith('generation-')).sort(),
    generations,
    'a dry run must not prune',
  );
});

// F-177: the retention helper always keeps the generation current.json names.
test('generation pruning never drops the current generation and bounds the rest', async t => {
  const base = await temporaryDir(t);
  const container = join(base, 'integration');
  await mkdir(container, { recursive: true });
  for (const number of [1, 2, 3, 4, 5]) {
    await mkdir(join(container, generationName(number)));
  }

  const result = await pruneGenerations(container, { keep: 2, current: 'generation-000002' });
  assert.deepEqual(result.retained, ['generation-000002', 'generation-000005']);
  assert.deepEqual(result.removed, ['generation-000001', 'generation-000003', 'generation-000004']);
  assert.deepEqual(
    (await readdir(container)).sort(),
    ['generation-000002', 'generation-000005'],
  );
});

// F-91: an interrupted install's staged copy is pruned; foreign entries survive.
test('install and uninstall prune owned stale stage directories only', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const studio = join(agent, 'herdr-dag-studio');
  const container = join(studio, 'integration');
  const owned = join(studio, 'integration.stage-owned');
  const foreign = join(studio, 'integration.stage-foreign');

  await mkdir(owned, { recursive: true });
  await writeFile(join(owned, '.installed-by'), marker);
  await writeFile(join(owned, 'extension.mjs'), 'stale');
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, 'notes.txt'), 'keep');

  const installed = await runScript('install.mjs', ['--agent-dir', agent]);
  assert.equal(installed.code, 0, installed.stderr);
  assert.equal(await exists(owned), false, 'an owned stage directory must be pruned before installing');
  assert.equal(await readFile(join(foreign, 'notes.txt'), 'utf8'), 'keep');

  const second = join(studio, 'integration.stage-second');
  await mkdir(second, { recursive: true });
  await writeFile(join(second, '.installed-by'), marker);

  const removed = await runScript('uninstall.mjs', ['--agent-dir', agent]);
  assert.equal(removed.code, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).removed, true);
  assert.equal(await exists(container), false);
  assert.equal(await exists(second), false, 'uninstall must not leave a staged copy behind');
  assert.equal(await readFile(join(foreign, 'notes.txt'), 'utf8'), 'keep');
});

// F-11: removal ignores a container that changed after the ownership read.
test('verifyManagedContainer refuses a changed inode or a changed marker', async t => {
  const base = await temporaryDir(t);
  const container = join(base, 'integration');
  await mkdir(container, { recursive: true });
  await writeFile(join(container, '.installed-by'), marker);
  const original = await lstat(container);
  const inode = { dev: original.dev, ino: original.ino };

  await verifyManagedContainer(container, inode);

  await assert.rejects(
    verifyManagedContainer(container, { dev: inode.dev, ino: inode.ino + 1 }),
    /changed after inspection/,
  );

  await writeFile(join(container, '.installed-by'), '// not ours');
  await assert.rejects(verifyManagedContainer(container, inode), /ownership marker changed/);
  assert.equal(await readFile(join(container, '.installed-by'), 'utf8'), '// not ours');
});

// F-90: creation and writes refuse a swapped component instead of following it.
test('install writes through O_NOFOLLOW and creates a generation exclusively', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');
  const container = join(agent, 'herdr-dag-studio', 'integration');
  const foreign = join(base, 'foreign');
  await mkdir(foreign, { recursive: true });
  await writeFile(join(foreign, 'precious.txt'), 'untouched');

  // The generation path is created exclusively: the EEXIST refusal is what
  // closes the window between choosing a number and creating the directory, so
  // a foreign directory can never be adopted as a freshly installed generation.
  await mkdir(join(base, 'squatter'));
  await writeFile(join(base, 'squatter', 'precious.txt'), 'untouched');
  await assert.rejects(
    mkdirExclusive(join(base, 'squatter'), 'integration generation'),
    /Refusing to reuse existing integration generation/,
  );
  assert.equal(await readFile(join(base, 'squatter', 'precious.txt'), 'utf8'), 'untouched');

  // A symlink at the write target is refused by the open(2) flags.
  await mkdir(join(agent, 'staged'), { recursive: true });
  const target = join(foreign, 'target.js');
  const linked = join(agent, 'staged', 'extension.mjs');
  await writeFile(target, 'original');
  await symlink(target, linked);
  await assert.rejects(
    writeFileNoFollow(linked, 'replacement', { agentDir: agent, kind: 'fixture' }),
    /ELOOP|too many symbolic links/i,
  );
  assert.equal(await readFile(target, 'utf8'), 'original');
});

// F-91: a signal during install cleans the staged copy it created.
test('SIGINT during an install removes the staged copy it created', { timeout: 60000 }, async t => {
  const base = await temporaryDir(t);
  const checkout = join(base, 'checkout');
  await mkdir(join(base, 'agent'), { recursive: true });
  await cp(join(repo, 'src'), join(checkout, 'src'), { recursive: true });
  await cp(join(repo, 'extension.mjs'), join(checkout, 'extension.mjs'));
  await cp(join(repo, 'LICENSE'), join(checkout, 'LICENSE'));
  await cp(join(repo, 'scripts'), join(checkout, 'scripts'), { recursive: true });
  // Enough payload that the copy is still running when the signal lands.
  for (let index = 0; index < 24; index++) {
    await mkdir(join(checkout, 'src', `bulk-${index}`), { recursive: true });
    await writeFile(join(checkout, 'src', `bulk-${index}`, 'payload.bin'), Buffer.alloc(512 * 1024, index));
  }
  const agent = join(base, 'agent');
  const studio = join(agent, 'herdr-dag-studio');

  const child = spawn(process.execPath, [join(checkout, 'scripts', 'install.mjs'), '--agent-dir', agent], {
    cwd: checkout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  t.after(() => { if (!exited) child.kill('SIGKILL'); });

  // Wait for the staging directory to exist, then interrupt the copy.
  await waitFor(async () => {
    const names = await readdir(studio).catch(() => []);
    return names.some(name => name.startsWith('integration.stage-'));
  }, { timeout: 10000, interval: 2, message: 'the staging directory to appear' });
  child.kill('SIGINT');
  const code = await new Promise(resolveExit => {
    child.on('exit', value => { exited = true; resolveExit(value); });
  });

  assert.equal(code, 130, 'SIGINT should exit with 128 + SIGINT');
  const leftover = (await readdir(studio).catch(() => [])).filter(name => name.startsWith('integration.stage-'));
  assert.deepEqual(leftover, [], 'the signal handler must remove the staged copy');
  assert.equal(await exists(join(agent, 'extensions', wrapperName)), false, 'no wrapper may be published');
});

// F-80: the user-facing CLI branches that the scripts alone never exercise.
test('the CLI serves help, version, unknown commands, and view errors', { timeout: 30000 }, async t => {
  const help = await runNode([cli]);
  assert.equal(help.code, 0, help.stderr);
  for (const usage of ['demo', 'view --state', 'install', 'uninstall', '--version']) {
    assert.ok(help.stdout.includes(usage), `--help should document ${usage}`);
  }

  const version = await runNode([cli, '--version']);
  assert.equal(version.code, 0, version.stderr);
  const pkg = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
  assert.equal(version.stdout.trim(), pkg.version);

  const unknown = await runNode([cli, 'bogus']);
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.stderr, /Unknown command: bogus/);

  const missingState = await runNode([cli, 'view']);
  assert.notEqual(missingState.code, 0);
  assert.match(missingState.stderr, /view requires --state PATH/);
});

test('the CLI dispatches install and uninstall through the shared scripts', { timeout: 30000 }, async t => {
  const base = await temporaryDir(t);
  const agent = join(base, 'agent');

  const installed = await runNode([cli, 'install', '--dry-run', '--agent-dir', agent]);
  assert.equal(installed.code, 0, installed.stderr);
  const plan = JSON.parse(installed.stdout);
  assert.equal(plan.installed, false);
  assert.equal(plan.agentDir, resolve(agent));
  assert.equal(plan.keepGenerations, 2);
  assert.equal(await exists(agent), false);

  const uninstalled = await runNode([cli, 'uninstall', '--dry-run', '--agent-dir', agent]);
  assert.equal(uninstalled.code, 0, uninstalled.stderr);
  assert.equal(JSON.parse(uninstalled.stdout).installed, false);
  assert.equal(await exists(agent), false);

  const real = await runNode([cli, 'install', '--agent-dir', agent]);
  assert.equal(real.code, 0, real.stderr);
  assert.equal(JSON.parse(real.stdout).installed, true);
  assert.equal(await exists(join(agent, 'extensions', wrapperName)), true);
});

// F-178: a fixed instant makes fixture generation byte-identical.
test('make-demo is deterministic with --at/--now and rejects malformed epochs', { timeout: 60000, concurrency: false }, async t => {
  const backup = await readFile(demoSnapshot, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  t.after(async () => {
    if (backup !== undefined) await writeFile(demoSnapshot, backup);
  });

  const first = await runScript('make-demo.mjs', ['--at', String(demoAt)]);
  assert.equal(first.code, 0, first.stderr);
  const snapshot = await readFile(demoSnapshot, 'utf8');
  assert.equal(JSON.parse(snapshot).generatedAt, new Date(demoAt).toISOString());

  const second = await runScript('make-demo.mjs', [`--now=${demoAt}`]);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(await readFile(demoSnapshot, 'utf8'), snapshot, 'a fixed instant must reproduce the snapshot');

  for (const args of [['--at', 'nonsense'], ['--now=']]) {
    const rejected = await runScript('make-demo.mjs', args);
    assert.notEqual(rejected.code, 0, args.join(' '));
    assert.match(rejected.stderr, /requires an epoch/);
  }
});
