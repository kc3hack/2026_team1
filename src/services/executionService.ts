
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ExecutionResult {
    success: boolean;
    output: string;
    error?: string;
}

export class ExecutionService {
    async execute(code: string): Promise<ExecutionResult> {
        return new Promise((resolve) => {
            const tempDir = os.tmpdir();
            // Use .js extension for simple execution. If TS is needed, we might need ts-node or compilation.
            // For now, assuming pure JS or easy TS that node can run (or requires compile).
            // Siyou.md said JS/TS. Running TS directly usually requires ts-node.
            // For simplicity, we'll try to run as JS. If user provides TS features, it might fail without ts-node.
            // We'll use .js
            const tempFile = path.join(tempDir, `docmate_exec_${Date.now()}.js`);

            fs.writeFileSync(tempFile, code);

            cp.exec(`node "${tempFile}"`, { timeout: 5000 }, (err, stdout, stderr) => {
                // Cleanup
                try {
                    fs.unlinkSync(tempFile);
                } catch (e) {
                    console.error('Failed to delete temp file:', e);
                }

                if (err) {
                    resolve({
                        success: false,
                        output: stdout,
                        error: stderr || err.message
                    });
                } else {
                    resolve({
                        success: true,
                        output: stdout
                    });
                }
            });
        });
    }
}
