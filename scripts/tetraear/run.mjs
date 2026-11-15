import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(root, '.cache/TetraEar');
const venv = path.join(root, '.cache/tetraear-venv');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const revision = 'c46141a62c5aec1a68ea7e3c1c570bcf461833e5';

function run(command, args) {
	const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[2] === '--setup') {
	if (!existsSync(source)) {
		run('git', ['clone', 'https://github.com/syrex1013/TetraEar.git', source]);
		run('git', ['-C', source, 'checkout', '--detach', revision]);
	} else {
		const head = spawnSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
		if (head.stdout?.trim() !== revision)
			throw new Error(`Existing TetraEar checkout differs from tested revision ${revision}; use --source for a custom checkout.`);
	}
	if (!existsSync(python)) run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv]);
	run(python, ['-m', 'pip', 'install', '-r', 'scripts/tetraear/requirements.txt']);
} else {
	if (!existsSync(python)) throw new Error('Run npm run setup:tetraear first.');
	run(python, ['scripts/tetraear/bridge.py', ...process.argv.slice(2)]);
}
