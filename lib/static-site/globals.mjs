// Injected into every module of the static bundle: the Node globals the
// transpiled code and its libraries reach for.
import { Buffer } from 'buffer';
import process from './process-shim.cjs';

export { Buffer, process };
