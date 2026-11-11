// Builds the Rust engine to WebAssembly and puts it where the worker imports it from.
import { spawnSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, PATH: `${join(homedir(), '.cargo/bin')}:${process.env.PATH}` };
const built = spawnSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown', '--manifest-path', 'engine/Cargo.toml'], { cwd: root, env, stdio: 'inherit' });
if (built.status !== 0) process.exit(built.status ?? 1);
const from = join(root, 'engine/target/wasm32-unknown-unknown/release/schmishape_engine.wasm');
const to = join(root, 'src/engine/engine.wasm');
copyFileSync(from, to);
console.log(`engine.wasm ${(statSync(to).size / 1024).toFixed(0)} KiB`);
