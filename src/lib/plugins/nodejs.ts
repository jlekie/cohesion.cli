import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as OS from 'os';
import * as Chalk from 'chalk';
import * as Toposort from 'toposort';
import * as Minimatch from 'minimatch';
import * as Globby from 'globby';
import * as Path from 'path';
import * as FS from 'fs-extra';
import * as Tmp from 'tmp-promise';
import Axios from 'axios';
import * as Yaml from 'js-yaml';

import { FluentType, FluentTypeCheckError } from '@jlekie/fluent-typebox';

import { ActionTypeDef, Action as ConfigAction } from '../config.types';
import { App, Action, parseArgs } from '../app';
import { PluginTypeDef } from '../plugin';
import { exec } from '../misc';

const colors = [ '#570600', '#575100', '#305700', '#00574b', '#002b57', '#280057', '#570037' ];
let colorIdx = 0;
function resolveColorIdx() {
    if (colorIdx < colors.length) {
        return colorIdx++;
    }
    else {
        colorIdx = 0;
        return colorIdx;
    }
}

export const NodeScriptType = FluentType.object({
    script: FluentType.string(),
    exec: FluentType.string().optional(),
    defaultExec: FluentType.string().optional()
}).compile();

export const PackageType = FluentType.object({
    name: FluentType.string().optional(),
    packageManager: FluentType.string().optional()
}).compile();

type PackageManagers = 'npm' | 'yarn' | 'pnpm';
async function resolvePackageManager(dirPath: string): Promise<PackageManagers | undefined> {
    const packagePath = Path.resolve(dirPath, 'package.json');
    const packageExists = await FS.pathExists(packagePath);

    if (packageExists) {
        const packageManifest = await FS.readJson(packagePath);
        if (!PackageType.check(packageManifest))
            throw new FluentTypeCheckError('package manifest validation failed', PackageType, packageManifest);

        if (packageManifest.packageManager) {
            const tmp = packageManifest.packageManager.match(/(npm|pnpm|yarn)@\d+\.\d+\.\d+(-.+)?/);
            if (!tmp || (tmp[1] !== 'npm' && tmp[1] !== 'yarn' && tmp[1] !== 'pnpm'))
                throw new Error('package manager value not recognized');

            return tmp[1];
        }
    }

    if (dirPath === Path.parse(dirPath).root)
        return undefined;
    else
        return await resolvePackageManager(Path.resolve(dirPath, '..'));
}

export default {
    registerActions: (options, registerAction) => {
        registerAction('node.script', async (action, execParams) => {
            var options = NodeScriptType.parse(action.action.options);

            const colorIdx = resolveColorIdx();

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            const npmExecutable = await (async () => {
                if (options.exec)
                    return options.exec;

                const packageManager = action.parentApp.path && await resolvePackageManager(action.parentApp.path);                    
                return packageManager === 'npm' ? 'npm'
                    : packageManager === 'yarn' ? 'yarn'
                    : packageManager === 'pnpm' ? 'pnpm'
                    : options.defaultExec ?? 'npm';
            })();

            await exec(`${npmExecutable} run ${_.template(options.script)(vars)}`, {
                cwd: action.parentApp.path,
                stdout: process.stdout,
                label: execParams.label ? '[' + Chalk.hex(colors[colorIdx])(execParams.label) + ']' : undefined
            });
        });
    }
} satisfies typeof PluginTypeDef.StaticType;
