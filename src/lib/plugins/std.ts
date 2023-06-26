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

import { Type } from '@jlekie/fluent-typebox';
import { typeDef } from '../types';

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

export const ExecTypeDef = typeDef('compiledParsed', Type.Object({
    requiredVariables: Type.Optional(Type.Array(Type.String())),
    ignoreExitCode: Type.Optional(Type.Boolean()),
    cmd: Type.Optional(Type.String()),
    platforms: Type.Optional(Type.Array(Type.String())),
    commands: Type.Optional(Type.Array(Type.Object({
        platforms: Type.Optional(Type.Array(Type.String())),
        cmd: Type.String(),
        env: Type.Optional(Type.Record(Type.String(), Type.String()))
    }))),
    env: Type.Optional(Type.Record(Type.String(), Type.String()))
}), value => ({
    requiredVariables: value.requiredVariables ?? [],
    ignoreExitCode: value.ignoreExitCode ?? false,
    commands: [
        ...(value.cmd ? [ { cmd: value.cmd, platforms: value.platforms, env: value.env } ] : []),
        ...(value.commands ? value.commands.map(i => ({ cmd: i.cmd, platforms: i.platforms, env: i.env })) : [])
    ],
    // env: value.env ?? {}
}));

export const LocalDelegateTypeDef = typeDef('compiledParsed', Type.Object({
    relative: Type.Optional(Type.Boolean()),
    parallel: Type.Optional(Type.Boolean()),
    variables: Type.Optional(Type.Record(Type.String(), Type.String())),
    task: Type.Union([ Type.String(), Type.Array(Type.String()) ])
}), value => ({
    relative: value.relative ?? false,
    parallel: value.parallel ?? false,
    variables: value.variables ?? {},
    tasks: typeof value.task === 'string' ? [ value.task ] : value.task
}));

export const DelegateTypeDef = typeDef('compiledParsed', Type.Object({
    dependencies: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    included: Type.Optional(Type.Record(Type.String(), Type.Union([ Type.String(), Type.Array(Type.String()) ]))),
    parallel: Type.Optional(Type.Boolean()),
    variables: Type.Optional(Type.Record(Type.String(), Type.String())),
    task: Type.Union([ Type.String(), Type.Array(Type.String()) ])
}), value => ({
    parallel: value.parallel ?? false,
    variables: value.variables ?? {},
    dependencies: value.dependencies ?? {},
    included: value.included && _.transform(value.included, (results, value, key) => {
        results[key] = typeof value === 'string' ? [ value.split(',') ] : value.map(v => v.split(','))
    }, {} as Record<string, string[][]>),
    tasks: typeof value.task === 'string' ? [ value.task ] : value.task
}));

export const WatchTypeDef = typeDef('compiledParsed', Type.Object({
    pattern: Type.Optional(Type.String()),
    patterns: Type.Optional(Type.Array(Type.String())),
    actions: Type.Array(ActionTypeDef.Schema()),
    parallel: Type.Optional(Type.Boolean())
}), value => ({
    patterns: [
        ...(value.pattern ? [ value.pattern ] : []),
        ...(value.patterns ?? [])
    ],
    actions: value.actions.map(a => ActionTypeDef.parse(a)),
    parallel: value.parallel ?? true
}));

export const FSCopyTypeDef = typeDef('compiledParsed', Type.Object({
    source: Type.String(),
    destination: Type.String(),
    sourceRoot: Type.Optional(Type.String()),
}), value => ({
    source: value.source,
    destination: value.destination,
    sourceRoot: value.sourceRoot
}));

export const FSEmptyTypeDef = typeDef('compiledParsed', Type.Object({
    path: Type.String()
}), value => ({
    path: value.path
}));

export const DenoTypeDef = typeDef('compiledParsed', Type.Object({
    permissions: Type.Optional(Type.Union([ Type.Literal(true), Type.Object({
        allowEnv: Type.Optional(Type.Boolean()),
        allowRead: Type.Optional(Type.Boolean()),
        allowWrite: Type.Optional(Type.Boolean()),
        allowSys: Type.Optional(Type.Boolean()),
        allowHrTime: Type.Optional(Type.Boolean()),
        allowNet: Type.Optional(Type.Boolean()),
        allowFfi: Type.Optional(Type.Boolean()),
        allowRun: Type.Optional(Type.Boolean()),
    }) ])),
    reload: Type.Optional(Type.Boolean()),
    unstable: Type.Optional(Type.Boolean()),
    script: Type.Union([
        Type.String(),
        Type.Object({
            inline: Type.String()
        }),
        Type.Object({
            uri: Type.String()
        })
    ])
}), value => ({
    permissions: value.permissions === true ? true : {
        allowEnv: value.permissions?.allowEnv ?? false,
        allowRead: value.permissions?.allowRead ?? false,
        allowWrite: value.permissions?.allowWrite ?? false,
        allowSys: value.permissions?.allowSys ?? false,
        allowHrTime: value.permissions?.allowHrTime ?? false,
        allowNet: value.permissions?.allowNet ?? false,
        allowFfi: value.permissions?.allowFfi ?? false,
        allowRun: value.permissions?.allowRun ?? false,
    },
    unstable: value.unstable ?? false,
    reload: value.reload ?? false,
    script: typeof value.script === 'string' ? { inline: value.script } : value.script
}));

export default {
    registerActions: (options, registerAction) => {
        registerAction('exec', async (action, execParams) => {
            const options = ExecTypeDef.checkAndParse(action.action.options);

            const colorIdx = resolveColorIdx();

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            for (const requiredVariable of options.requiredVariables) {
                if (!vars[requiredVariable])
                    throw new Error(`Required variable ${requiredVariable} not defined`);
            }

            for (const command of options.commands) {
                if (command.platforms && command.platforms.indexOf(OS.platform()) < 0)
                    continue;

                await exec(_.template(command.cmd)(vars), {
                    cwd: action.parentApp.path,
                    stdout: process.stdout,
                    ignoreExitCode: options.ignoreExitCode,
                    label: execParams.label ? '[' + Chalk.hex(colors[colorIdx])(execParams.label) + ']' : undefined,
                    env: command.env
                });
            }
        });

        registerAction('delegate.local', async (action, execParams) => {
            const options = LocalDelegateTypeDef.checkAndParse(action.action.options);

            const parsedArgs = parseArgs(options.tasks);

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            const forwardedVars: Record<string, string> = {};
            for (const key in options.variables)
                forwardedVars[key] = _.template(options.variables[key])(vars);

            await (options.parallel ? Bluebird.map : Bluebird.mapSeries)(parsedArgs, a => (options.relative ? action.parentTask : action.parentApp)?.exec(a, {
                ...execParams,
                label: undefined,
                vars: {
                    ...execParams.vars,
                    ...forwardedVars
                }
            }));
        });

        registerAction('delegate', async (action, execParams) => {
            const options = DelegateTypeDef.checkAndParse(action.action.options);

            let modules: Array<App> = [];
            for await (const app of action.parentApp.resolveModules())
                modules.push(app);

            const dependencies = {
                ...options.dependencies,
                ...action.parentApp.config.dependencies
            };

            if (!_.isEmpty(dependencies)) {
                const pathspecs = modules.map(c => c.config.labels['cohesion:pathspec'][0]);

                const explodedDependencies: [string, string][] = [];
                for (const key in dependencies) {
                    const keyMatches = pathspecs.filter(c => Minimatch(c, key));
                    const valueMatches = pathspecs.filter(c => dependencies[key].some(v => Minimatch(c, v)));

                    for (const keyMatch of keyMatches)
                        for (const valueMatch of valueMatches)
                            explodedDependencies.push([ keyMatch, valueMatch ]);
                }
                // console.log(explodedDependencies)

                const sortedPathspecs = Toposort(explodedDependencies).reverse();
                modules = _(modules)
                    .orderBy(c => sortedPathspecs.findIndex(p => p === c.config.labels['cohesion:pathspec'][0]))
                    .filter(c => _.isEmpty(options.included) || _.every(options.included, (value, key) => _.some(value, v => v.every(vv => c.config.labels[key]?.indexOf(vv) >= 0))))
                    .value();

                // configs = Toposort(explodedDependencies).reverse()
                //     .map(p => configs.find(c => c.labels['cohesion:pathspec'] === p) as Config)
                //     .filter(config => _.isEmpty(this.included) || _.some(this.included, (value, key) => _.some(value, v => v.every(vv => config.labels[key] === vv))));
            }
            else {
                modules = _(modules)
                    .filter(c => _.isEmpty(options.included) || _.every(options.included, (value, key) => _.some(value, v => v.every(vv => c.config.labels[key]?.indexOf(vv) >= 0))))
                    .value();
            }

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            const forwardedVars: Record<string, string> = {};
            for (const key in options.variables)
                forwardedVars[key] = _.template(options.variables[key])(vars);

            // const tasks = options.task ?? (this.parentTask ? [ this.parentTask.name ] : undefined);
            // if (!tasks)
            //     throw new Error('No delegated task defined');

            for (const task of options.tasks) {
                const parsedArgs = parseArgs(task);

                if (options.parallel) {
                    await Bluebird.map(modules, c => c.exec(parsedArgs, {
                        ...execParams,
                        label: `${execParams.label ? execParams.label + '/' : ''}${c.config.name}`,
                        vars: {
                            ...execParams.vars,
                            ...forwardedVars
                        }
                    }));
                }
                else {
                    await Bluebird.mapSeries(modules, c => c.exec(parsedArgs, {
                        ...execParams,
                        label: `${execParams.label ? execParams.label + '/' : ''}${c.config.name}`,
                        vars: {
                            ...execParams.vars,
                            ...forwardedVars
                        }
                    }));
                }
            }
        });

        registerAction('watch', async (action, execParams) => {
            const options = WatchTypeDef.checkAndParse(action.action.options);

            const actions = options.actions.map(a => new Action({
                action: a,
                parentApp: action.parentApp,
                parentTask: action.parentTask
            }));

            const execute = _.debounce(async () => {
                if (options.parallel) {
                    await Bluebird.map(actions, action => action.exec(execParams));
                }
                else {
                    for (const action of actions)
                        await action.exec(execParams);
                }
            }, 500);
    
            const matches = await Bluebird.map(Globby(options.patterns, { cwd: action.parentApp.path, absolute: true }), async path => ({
                path,
                stats: await FS.stat(path)
            }));
            for (const match of matches) {
                FS.watch(match.path, { persistent: true }, (e, filename) => {
                    FS.stat(match.path).then(stats => {
                        if (stats.mtimeMs !== match.stats.mtimeMs) {
                            execute();
                        }
                    });
                });
            }
        });

        registerAction('fs.copy', async (action, execParams) => {
            const options = FSCopyTypeDef.checkAndParse(action.action.options);

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            const source = Path.resolve(_.template(options.source)(vars));
            const destination = Path.resolve(_.template(options.destination)(vars));
            const sourceRoot = options.sourceRoot ? Path.resolve(_.template(options.sourceRoot)(vars)) : undefined;

            if (source.indexOf('*') < 0) {
                await FS.copy(source, destination);
                console.log(`[${Chalk.blue(execParams.label)}] Copied ${source} to ${destination}`);
            }
            else {
                const sourcePattern = Path.relative(action.parentApp.path ?? '.', source).split(Path.sep).join(Path.posix.sep);
                const sourceFiles = await Globby(sourcePattern, { cwd: action.parentApp.path, onlyFiles: false });

                if (await FS.pathExists(destination) && !(await FS.stat(destination)).isDirectory())
                    throw new Error(`invalid destination ${destination}`);

                for (const sourceFile of sourceFiles) {
                    const resolvedSourcePath = Path.resolve(action.parentApp.path ?? '.', sourceFile);
                    const resolvedDestinationPath = Path.resolve(destination, sourceRoot ? Path.relative(sourceRoot, resolvedSourcePath) : sourceFile);

                    await FS.copy(resolvedSourcePath, resolvedDestinationPath);
                    console.log(`[${Chalk.blue(execParams.label)}] Copied ${resolvedSourcePath} to ${resolvedDestinationPath}`);
                }
            }

            // await FS.ensureDir
            // await FS.copyFile(source, destination);
            // console.log(`[${Chalk.blue(execParams.label)}] Copied ${source} to ${destination}`);
        });

        registerAction('fs.empty', async (action, execParams) => {
            const options = FSEmptyTypeDef.checkAndParse(action.action.options);

            const vars = {
                ...await (action.parentTask?.task ?? action.parentApp.config)?.resolveVariables(),
                ...execParams.vars
            }

            const path = Path.resolve(action.parentApp.path ?? '.', _.template(options.path)(vars));

            await FS.emptyDir(path);
            console.log(`[${Chalk.blue(execParams.label)}] Emptied ${path}`);
        });

        registerAction('deno', async (action, execParams) => {
            const options = DenoTypeDef.checkAndParse(action.action.options);

            const colorIdx = resolveColorIdx();

            const execScript = async (path: string) => {
                const permissionArgs = [];
                if (typeof options.permissions === 'boolean') {
                    options.permissions && permissionArgs.push('--allow-all');
                }
                else {
                    options.permissions.allowEnv && permissionArgs.push('--allow-env');
                    options.permissions.allowRead && permissionArgs.push('--allow-read');
                    options.permissions.allowWrite && permissionArgs.push('--allow-write');
                    options.permissions.allowSys && permissionArgs.push('--allow-allowSys');
                    options.permissions.allowHrTime && permissionArgs.push('--allow-hrtime');
                    options.permissions.allowNet && permissionArgs.push('--allow-net');
                    options.permissions.allowFfi && permissionArgs.push('--allow-ffi');
                    options.permissions.allowRun && permissionArgs.push('--allow-run');
                }

                options.unstable && permissionArgs.push('--unstable');

                options.reload && permissionArgs.push('-r');

                await exec(`deno run ${permissionArgs.join(' ')} ${path}`, {
                    cwd: action.parentApp.path,
                    stdout: process.stdout,
                    label: execParams.label ? '[' + Chalk.hex(colors[colorIdx])(execParams.label) + ']' : undefined
                });
            }

            if ('inline' in options.script) {
                const script = options.script.inline;

                await Tmp.file({
                    postfix: '.ts'
                }).then(async ({ path, cleanup }) => {
                    await FS.writeFile(path, script);

                    await execScript(path);
        
                    await cleanup();
                });
            }
            else {
                const [ protocol, path ] = options.script.uri.split('://', 2);

                let uri: string;
                switch (protocol) {
                    case 'http':
                    case 'https': {
                        uri = options.script.uri;
                    } break;
                    case 'file': {
                        uri = Path.resolve(action.parentApp.path ?? '.', path);
                    } break;
                    default:
                        throw new Error(`unsupported config URI [${options.script.uri}]`);
                }

                await execScript(uri);
            }
        });
    }
} satisfies typeof PluginTypeDef.StaticType;
