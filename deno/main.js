// Deno Deploy entrypoint for the ViaggiaTreno proxy.
import { handle } from './proxy.js';

Deno.serve(handle);
