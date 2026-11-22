import { beforeEach } from 'vitest';

// Vitest gives a worker 60 s to receive the replies to its reports (onTaskUpdate). Tests that are all synchronous run
// back to back without returning to the event loop, so on a slow machine a heavy file (HFDL, LoRa satellites,
// Inmarsat-C) could hold those replies past the limit and fail the run with "Timeout calling onTaskUpdate" although
// every test passed. Returning to the event loop before each test lets the replies through. The real setImmediate is
// kept from before any test installs fake timers, which would otherwise never fire it.
const realSetImmediate = globalThis.setImmediate;
beforeEach(() => new Promise((resolve) => realSetImmediate(resolve)));
