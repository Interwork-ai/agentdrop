/** Host-specific code lives in ./harnesses/<key>.ts; this module is the stable entry point for the rest of the CLI. */
export {
  connectableHarnesses,
  detectHarnesses,
  HARNESSES,
  type Harness,
  type HarnessAdapter,
  harness,
  harnessChoices,
  harnessLabels,
  isConnectableHarness,
  parseHarnessList,
} from './harnesses/index.js';
