import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';

// Execute the real service source with explicit dependencies, without importing app/config or starting clients.
export function loadBondService(file: string, dependencies: Record<string, unknown>) {
    const filename = path.resolve(__dirname, '..', 'app', 'modules', file);
    const localRequire = createRequire(filename);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const module = { exports: {} as any };
    const safe = new Set([
        'http-status', '../../error/appError', '../../builder/QueryBuilder',
        '../../utilities/pagination', '../../utilities/enum',
        './bondRequest.enum', './bondRequest.publicShape', './matching.schedule', './matching.config', './matching.colors', './matching.cache',
        './bondLink.enum', './bondLink.lifecycle', '../conversation/conversation.enum',
        '../bondRequest/bondRequest.enum', '../bondRequest/matching.colors',
        '../normalUser/normalUser.enum', './bondIdentity', './bondIntegrity', '../bondRequest/bondIntegrity',
    ]);
    const requireDependency = (id: string) => {
        if (Object.hasOwn(dependencies, id)) return dependencies[id];
        if (safe.has(id)) return localRequire(id);
        throw new Error(`Unstubbed service dependency: ${id}`);
    };
    vm.runInNewContext(output, { module, exports: module.exports, require: requireDependency,
        console, process: { env: {} }, Date, Set, Map, Promise, RegExp, Array, Object, String, Number, Math,
    }, { filename });
    return module.exports.default;
}
