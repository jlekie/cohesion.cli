import * as _ from 'lodash';
import * as Bluebird from 'bluebird';
import * as Stream from 'stream';
import * as Globby from 'globby';

import * as Types from './types';
import * as Config from './config.types';
import { loadPlugin } from './plugin';
import StdPlugin from './plugins/std';

import * as OS from 'os';
import { exec } from './misc';

export interface ExecParams {
    stdout?: Stream.Writable;
    label?: string;
    vars: Record<string, string>;
}

export type ParsedArgs = string[][][][];
export function parseArgs(args: string): string[][][];
export function parseArgs(args: string[]): string[][][][];
export function parseArgs(args: string | string[]): string[][][] | string[][][][] {
    if (_.isString(args)) {
        return args.split('.').map(b => 
            b.split('|').map(c => 
                c.split(/,| /)));
    }
    else {
        return args.map(a => 
            a.split('.').map(b => 
                b.split('|').map(c => 
                    c.split(/,| /))));
    }
}

// export interface ExecActionParams {
//     commands: ExecAction['commands'];
//     requiredVariables?: ExecAction['requiredVariables'];
//     ignoreExitCode?: ExecAction['ignoreExitCode'];
// }
// export class ExecAction {
//     public commands: Array<{
//         platforms: string[];
//         cmd: string;
//     }>;
//     public requiredVariables: string[];
//     public ignoreExitCode: boolean;

//     public static parse(value: unknown) {
//         if (!Types.ExecActionOptionsTypeCheck.Check(value))
//             throw new Error('exec action parse failure', { cause: Types.ExecActionOptionsTypeCheck.Errors(value) })

//         return this.fromSchema(value);
//     }
//     public static fromSchema(value: Types.ExecActionOptions) {
//         return new ExecAction({
//             ...value,
//             commands: [
//                 ...(value.cmd ? [ { cmd: value.cmd, platforms: value.platforms ?? [] } ] : []),
//                 ...(value.commands ? value.commands.map(i => ({ cmd: i.cmd, platforms: i.platforms ?? [] })) : [])
//             ]
//         });
//     }

//     public constructor(params: ExecActionParams) {
//         this.commands = params.commands;
//         this.requiredVariables = params.requiredVariables ?? [];
//         this.ignoreExitCode = params.ignoreExitCode ?? false;
//     }

//     public async exec(action: Action, execParams: ExecParams) {
//         const vars = {
//             // ...await (this.parentTask ?? this.parentConfig)?.resolveVariables(),
//             ...execParams.vars
//         }

//         for (const requiredVariable of this.requiredVariables) {
//             if (!vars[requiredVariable])
//                 throw new Error(`Required variable ${requiredVariable} not defined`);
//         }

//         for (const command of this.commands) {
//             if (command.platforms && command.platforms.indexOf(OS.platform()) < 0)
//                 continue;

//             // await exec(_.template(command.cmd)(vars), {
//             //     cwd: this.parentConfig?.path,
//             //     stdout: process.stdout,
//             //     ignoreExitCode: this.ignoreExitCode,
//             //     label: execParams.label ? '[' + Chalk.hex(colors[this.#colorIdx])(execParams.label) + ']' : undefined
//             // });
//         }
//     }
// }

export async function loadApp(config: Config.Config) {
    const app = new App({ config });

    StdPlugin.registerActions({}, app.registerAction.bind(app));
    await app.init();
    // app.registerAction('exec', (action, params) => ExecAction.parse(action.action.options).exec(action, params));

    return app;
}

export interface AppParams {
    config: App['config'];
}
export class App {
    public readonly config: Config.Config;

    public readonly tasks: Task[];
    public readonly actions: Action[];

    private readonly registeredActions: Record<string, (action: Action, params: ExecParams) => void | Promise<void>> = {};

    public get path() {
        return this.config.path;
    }

    public constructor(params: AppParams) {
        this.config = params.config;

        this.tasks = this.config.tasks.map(task => new Task({
            task,
            parentApp: this
        }));
        this.actions = this.config.actions.map(action => new Action({
            action,
            parentApp: this
        }));
    }

    public async init() {
        await Bluebird.map(this.config.plugins, async plugin => {
            const loadedPlugin = await loadPlugin(plugin.module);

            loadedPlugin.registerActions(plugin.options, this.registerAction);
        });
    }

    public async exec(args: string[][][], execParams: ExecParams = { vars: {} }) {
        if (args.length) {
            await Bluebird.map(args[0], async parg => {
                await Bluebird.mapSeries(parg, async sarg => {
                    await this.tasks.find(t => t.task.name === sarg)?.exec(args.slice(1), execParams);
                });
            });
        }
        else {
            if (this.actions.length) {
                for (const action of this.actions)
                    await action.exec(execParams);
            }
            else {
                for (const task of this.tasks)
                    await task.exec([], execParams);
            }
        }
    }

    public resolveActionHandler(type: string) {
        if (!this.registeredActions[type])
            throw new Error(`action type ${type} not defined`);

        return this.registeredActions[type];
    }

    public async registerAction(type: string, handler: (action: Action, params: ExecParams) => void) {
        if (this.registeredActions[type])
            throw new Error(`action ${type} already registered`);

        this.registeredActions[type] = handler;
    }

    public async *resolveModules(): AsyncGenerator<App> {
        for await (const config of this.config.resolveConfigs())
            yield loadApp(config);
    }

    // public async registerPlugin() {

    // }
}

export interface TaskParams {
    task: Task['task'];
    parentApp: Task['parentApp'];
    parentTask?: Task['parentTask'];
}
export class Task {
    public readonly task: Config.Task;
    public readonly parentApp: App;
    public readonly parentTask?: Task;

    public readonly tasks: Task[];
    public readonly actions: Action[]

    public constructor(params: TaskParams) {
        this.task = params.task;
        this.parentApp = params.parentApp;
        this.parentTask = params.parentTask;

        this.tasks = this.task.tasks.map(task => new Task({
            task,
            parentApp: this.parentApp,
            parentTask: this
        }));
        this.actions = this.task.actions.map(action => new Action({
            action,
            parentApp: this.parentApp,
            parentTask: this
        }));
    }

    public async exec(args: string[][][], execParams: ExecParams) {
        if (args.length) {
            await Bluebird.map(args[0], async parg => {
                await Bluebird.mapSeries(parg, async sarg => {
                    await this.tasks.find(t => t.task.name === sarg)?.exec(args.slice(1), {
                        ...execParams,
                        label: `${execParams.label ? execParams.label + '.' : ''}${this.task.name}`
                    });
                });
            });
        }
        else {
            if (this.task.parallel) {
                if (this.actions.length) {
                    await Bluebird.map(this.actions, action => action.exec({
                        ...execParams,
                        label: `${execParams.label ? execParams.label + '.' : ''}${this.task.name}`
                    }));
                }
                else {
                    await Bluebird.map(this.tasks, task => task.exec([], {
                        ...execParams,
                        label: `${execParams.label ? execParams.label + '.' : ''}${this.task.name}`
                    }));
                }
            }
            else {
                if (this.actions.length) {
                    for (const action of this.actions) {
                        await action.exec({
                            ...execParams,
                            label: `${execParams.label ? execParams.label + '.' : ''}${this.task.name}`
                        });
                    }
                }
                else {
                    for (const task of this.tasks) {
                        await task.exec([], {
                            ...execParams,
                            label: `${execParams.label ? execParams.label + '.' : ''}${this.task.name}`
                        });
                    }
                }
            }
        }
    }
}

export interface ActionParams {
    action: Action['action']
    parentApp: Action['parentApp'];
    parentTask?: Action['parentTask'];
}
export class Action {
    public readonly action: Config.Action;
    public readonly parentApp: App;
    public readonly parentTask?: Task;

    public constructor(params: ActionParams) {
        this.action = params.action;
        this.parentApp = params.parentApp;
        this.parentTask = params.parentTask;
    }

    public async exec(execParams: ExecParams = { vars: {} }) {
        const actionHandler = this.parentApp.resolveActionHandler(this.action.type);

        await actionHandler(this, execParams);
    }
}
