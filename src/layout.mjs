import { join } from 'node:path';

// The installer and the installed extension must agree on this tree:
//   <agent-dir>/herdr-dag-studio/integration/generation-NNNNNN/extension.mjs
// with current.json beside the generation directories it names. Both sides
// import this module, so the pointer path cannot drift apart again. It lives
// under src/ because scripts/ is not copied into an installed generation while
// src/ is.
export const pointerFile = 'current.json';

export function studioDirectory(agentDir) {
  return join(agentDir, 'herdr-dag-studio');
}

export function integrationDirectory(agentDir) {
  return join(studioDirectory(agentDir), 'integration');
}

// Callers pass the integration directory: the installer holds it directly and
// the installed extension derives it from the generation directory it runs in.
export function generationPointer(integrationDir) {
  return join(integrationDir, pointerFile);
}
