import * as OS from 'os';

import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Zod from 'zod';

import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Globby from 'globby';
import * as Path from 'path';
import * as Minimatch from 'minimatch';

import * as Toposort from 'toposort';

import * as Dotenv from 'dotenv';

import { exec } from './misc';

interface ConfigInitializer {
    name?: (config: Config) => string;
}

export type ActionSchema = ExecActionSchema | DelegateActionSchema | WatchActionSchema | LocalDelegateActionSchema | CopyActionSchema | EmptyActionSchema | ReloadVariablesActionSchema;
export const ActionSchema: Zod.ZodType<ActionSchema> = Zod.lazy(() => Zod.discriminatedUnion('type', [
    ExecActionSchema,
    DelegateActionSchema,
    WatchActionSchema,
    LocalDelegateActionSchema,
    CopyActionSchema,
    EmptyActionSchema,
    ReloadVariablesActionSchema
]));

export interface ExecActionSchema {
    type: 'exec';
    cmd?: string;
    requiredVariables?: string[];
    ignoreExitCode?: boolean;
    commands?: Array<{
        platforms?: string[],
        cmd: string
    }>;
}
export const ExecActionSchema = Zod.object({
    type: Zod.literal('exec'),
    cmd: Zod.string().optional(),
    requiredVariables: Zod.string().array().optional(),
    ignoreExitCode: Zod.boolean().optional(),
    platforms: Zod.string().array().optional(),
    commands: Zod.object({
        platforms: Zod.string().array().optional(),
        cmd: Zod.string()
    }).array().optional()
});

export interface LocalDelegateActionSchema {
    type: 'delegate.local';
    relative?: boolean;
    parallel?: boolean;
    variables?: Record<string, string>;
    task: string | string[];
}
export const LocalDelegateActionSchema = Zod.object({
    type: Zod.literal('delegate.local'),
    relative: Zod.boolean().optional(),
    parallel: Zod.boolean().optional(),
    variables: Zod.record(Zod.string(), Zod.string()).optional(),
    task: Zod.union([
        Zod.string(),
        Zod.string().array()
    ])
});

export interface DelegateActionSchema {
    type: 'delegate';
    dependencies?: Record<string, string[]>;
    included?: Record<string, string | string[]>;
    task?: string | string[];
    parallel?: boolean;
    variables?: Record<string, string>;
}
export const DelegateActionSchema = Zod.object({
    type: Zod.literal('delegate'),
    dependencies: Zod.record(Zod.string(), Zod.string().array()).optional(),
    included: Zod.record(Zod.string(), Zod.union([ Zod.string(), Zod.string().array() ])).optional(),
    task: Zod.union([
        Zod.string(),
        Zod.string().array()
    ]).optional(),
    parallel: Zod.boolean().optional(),
    variables: Zod.record(Zod.string(), Zod.string()).optional()
});

export interface WatchActionSchema {
    type: 'watch';
    patterns?: string[];
    actions?: ActionSchema[];
    parallel?: boolean;
}
export const WatchActionSchema = Zod.object({
    type: Zod.literal('watch'),
    patterns: Zod.string().array().optional(),
    actions: ActionSchema.array().optional(),
    parallel: Zod.boolean().optional(),
});

export interface CopyActionSchema {
    type: 'copy';
    source: string;
    destination: string;
}
export const CopyActionSchema = Zod.object({
    type: Zod.literal('copy'),
    source: Zod.string(),
    destination: Zod.string()
});

export interface EmptyActionSchema {
    type: 'fs.empty';
    path: string;
}
export const EmptyActionSchema = Zod.object({
    type: Zod.literal('fs.empty'),
    path: Zod.string()
});

export interface ReloadVariablesActionSchema {
    type: 'variables.reload';
}
export const ReloadVariablesActionSchema = Zod.object({
    type: Zod.literal('variables.reload')
});

export interface TaskSchema {
    name: string;
    parallel?: boolean;
    actions?: (Zod.infer<typeof ActionSchema> | string)[];
    tasks?: TaskSchema[];
    variables?: Record<string, string | null>;
    pathVariables?: Record<string, string>;
}
export const TaskSchema: Zod.ZodType<TaskSchema> = Zod.lazy(() => Zod.object({
    name: Zod.string(),
    parallel: Zod.boolean().optional(),
    actions: Zod.union([ ActionSchema, Zod.string() ]).array().optional(),
    tasks: TaskSchema.array().optional(),
    variables: Zod.record(Zod.string(), Zod.string().nullable()).optional(),
    pathVariables: Zod.record(Zod.string(), Zod.string()).optional()
}));

export const ModuleReferenceSchema = Zod.union([
    Zod.string(),
    Zod.object({
        patterns: Zod.union([
            Zod.string(),
            Zod.string().array()
        ]),
        labels: Zod.record(Zod.string(), Zod.string())
    })
]);

export const VariableFileReferenceSchema = Zod.union([
    Zod.string(),
    Zod.object({
        path: Zod.string(),
        prefix: Zod.string().optional()
    })
]);

export const ConfigSchema = Zod.object({
    modules: Zod.union([
        ModuleReferenceSchema,
        ModuleReferenceSchema.array()
    ]).optional(),
    labels: Zod.record(Zod.string(), Zod.union([ Zod.string(), Zod.string().array() ])).optional(),
    tags: Zod.string().array().optional(),
    tasks: TaskSchema.array().optional(),
    actions: Zod.union([ ActionSchema, Zod.string() ]).array().optional(),
    dependencies: Zod.record(Zod.string(), Zod.string().array()).optional(),
    variables: Zod.record(Zod.string(), Zod.string().nullable()).optional(),
    pathVariables: Zod.record(Zod.string(), Zod.string()).optional(),
    variableFiles: VariableFileReferenceSchema.array().optional()
});

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

export interface ExecParams {
    vars: Record<string, string>;
}

export interface VariableFileReferenceParams {
    path: VariableFileReference['path'];
    prefix?: VariableFileReference['prefix'];
}
export class VariableFileReference {
    public path: string;
    public prefix?: string;

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    public static parse(value: unknown) {
        return this.fromSchema(VariableFileReferenceSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof VariableFileReferenceSchema>) {
        if (_.isString(value)) {
            return new VariableFileReference({
                path: value
            });
        }
        else {
            const variableFileReference: VariableFileReference = new VariableFileReference({
                ...value
            });
    
            return variableFileReference;
        }
    }

    public constructor(params: VariableFileReferenceParams) {
        this.path = params.path;
        this.prefix = params.prefix;
    }

    public register(parentConfig: Config) {
        this.#parentConfig = parentConfig;

        return this;
    }

    public async resolveVariables(): Promise<Record<string, string>> {
        const path = Path.resolve(this.parentConfig?.path ?? '.', this.path);
        if (!await FS.pathExists(path))
            return {};

        const vars = _.reduce(await FS.readFile(path, 'utf8').then(content => Dotenv.parse(content)), (vars, value, key) => ({
            ...vars,
            [`${this.prefix}${key}`]: value as string
        }), {} as Record<string, string>);

        return vars;
    }
}

export interface ConfigParams {
    modules?: Config['modules'];
    labels?: Config['labels'];
    tags?: Config['tags'];
    tasks?: Config['tasks'];
    actions?: Config['actions'];
    dependencies?: Config['dependencies'];
    variables?: Config['variables'];
    pathVariables?: Config['pathVariables'];
    variableFiles?: Config['variableFiles'];
}
export class Config {
    public modules: ModuleReference[];
    public labels: Record<string, string[]>;
    public tags: string[];
    public tasks: Task[];
    public actions: Action[];
    public dependencies: Record<string, string[]>;
    public variables: Record<string, string | null>;
    public pathVariables: Record<string, string>;
    public variableFiles: VariableFileReference[];

    #path?: string;
    public get path() {
        return this.#path;
    }

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    #initializer?: ConfigInitializer;
    public get initializer() {
        return this.#initializer;
    }

    #name?: string;
    public get name() {
        return this.#name;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ConfigSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ConfigSchema>) {
        const config: Config = new Config({
            ...value,
            modules: value.modules ? (_.isArray(value.modules) ? value.modules.map(m => ModuleReference.fromSchema(m)) : [ ModuleReference.fromSchema(value.modules) ]) : undefined,
            tasks: value.tasks?.map(i => Task.fromSchema(i)),
            actions: value.actions?.map(i => _.isString(i) ? new LocalDelegateAction({ relative: true, task: [ i ] }) : AAction.fromSchema(i)),
            variableFiles: value.variableFiles?.map(i => VariableFileReference.fromSchema(i)),
            labels: value.labels ? _.transform(value.labels, (memo, value, key) => memo[key] = _.isArray(value) ? value : [ value ], {} as Record<string, string[]>) : undefined
        });

        return config;
    }

    public constructor(params: ConfigParams) {
        this.modules = params.modules ?? [];
        this.labels = params.labels ?? {};
        this.tags = params.tags ?? [];
        this.tasks = params.tasks ?? [];
        this.actions = params.actions ?? [];
        this.dependencies = params.dependencies ?? {};
        this.variables = params.variables ?? {};
        this.pathVariables = params.pathVariables ?? {};
        this.variableFiles = params.variableFiles ?? [];
    }

    public register(path: string, { parentConfig, initializer }: { parentConfig?: Config, initializer?: ConfigInitializer } = {}) {
        this.#path = path;
        this.#parentConfig = parentConfig;
        this.#initializer = initializer;
        // this.#name = initializer?.name?.(this);
        this.#name = Path.basename(path);

        this.tasks.forEach(t => t.register(this));
        this.actions.forEach(a => a.register(this));

        this.variableFiles.forEach(i => i.register(this));

        return this;
    }

    public async *resolveConfigs(): AsyncGenerator<Config> {
        const matchedFiles: Record<string, Record<string, string>> = {};

        for (const modulePattern of this.modules) {
            const matches = await Globby(modulePattern.patterns);
            for (const match of matches)
                matchedFiles[match] = _.defaults(matchedFiles[match] ?? {}, modulePattern.labels);
        }

        for (const match in matchedFiles) {
            const config = await loadConfig(match, {
                parentConfig: this,
                initializer: this.#initializer
            });
            config.labels = {
                ...config.labels,
                ...matchedFiles[match],
                'cohesion:pathspec': [ Path.relative(this.path ?? '.', config.path ?? '.').replace('\\', '/') ]
            };

            yield config;
            for await (const peerConfig of config.resolveConfigs())
                yield peerConfig;
        }

        // for (const modulePattern of this.modules) {
        //     const matches = await Globby(modulePattern.patterns);
        //     for (const match of matches) {
        //         const config = await loadConfig(match, {
        //             parentConfig: this,
        //             initializer: this.#initializer
        //         });
        //         config.labels = {
        //             ...config.labels,
        //             ...modulePattern.labels
        //         }

        //         yield config;
        //         for await (const peerConfig of config.resolveConfigs())
        //             yield peerConfig;
        //     }
        // }
    }

    public async resolveVariables(): Promise<Record<string, string | null>> {
        const pathVariables: Record<string, string> = {};
        for (const key in this.pathVariables)
            pathVariables[key] = Path.resolve(this.path ?? '.', this.pathVariables[key])

        return {
            ...this.variables,
            ...await Bluebird.reduce(this.variableFiles, async (vars, ref) => ({
                ...vars,
                ...await ref.resolveVariables()
            }), {} as Record<string, string>),
            ...pathVariables,
            // ...await this.parentConfig?.resolveVariables()
        }
    }

    public async exec(args: string[][][], execParams: ExecParams = { vars: {} }) {
        if (args.length) {
            await Bluebird.map(args[0], async parg => {
                await Bluebird.mapSeries(parg, async sarg => {
                    await this.tasks.find(t => t.name === sarg)?.exec(args.slice(1), execParams);
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
}

export interface ModuleReferenceParams {
    patterns: ModuleReference['patterns'];
    labels?: ModuleReference['labels'];
}
export class ModuleReference {
    public patterns: string[];
    public labels: Record<string, string>;

    public static parse(value: unknown) {
        return this.fromSchema(ModuleReferenceSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ModuleReferenceSchema>) {
        if (_.isString(value)) {
            return new ModuleReference({
                patterns: [ value ]
            });
        }
        else {
            return new ModuleReference({
                ...value,
                patterns: _.isArray(value.patterns) ? value.patterns : [ value.patterns ]
            });
        }
    }

    public constructor(params: ModuleReferenceParams) {
        this.patterns = params.patterns;
        this.labels = params.labels ?? {};
    }
}

export interface TaskParams {
    name: Task['name'];
    parallel: Task['parallel'];
    actions?: Task['actions'];
    tasks?: Task['tasks'];
    variables?: Task['variables'];
    pathVariables?: Task['pathVariables'];
}
export class Task {
    public name: string;
    public parallel: boolean;
    public actions: Action[];
    public tasks: Task[];
    public variables: Record<string, string | null>;
    public pathVariables: Record<string, string>;

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    #parentTask?: Task;
    public get parentTask() {
        return this.#parentTask;
    }

    public static parse(value: unknown) {
        return this.fromSchema(TaskSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof TaskSchema>): Task {
        return new Task({
            ...value,
            parallel: value.parallel ?? false,
            actions: value.actions?.map(i => _.isString(i) ? new LocalDelegateAction({ relative: true, task: [ i ] }) : AAction.fromSchema(i)),
            tasks: value.tasks?.map(i => Task.fromSchema(i))
        });
    }

    public constructor(params: TaskParams) {
        this.name = params.name;
        this.parallel = params.parallel;
        this.actions = params.actions ?? [];
        this.tasks = params.tasks ?? [];
        this.variables = params.variables ?? {};
        this.pathVariables = params.pathVariables ?? {};
    }

    public register(parentConfig: Config, parentTask?: Task) {
        this.#parentConfig = parentConfig;
        this.#parentTask = parentTask;

        this.tasks.forEach(t => t.register(parentConfig, this));
        this.actions.forEach(a => a.register(parentConfig, this));

        return this;
    }

    public async exec(args: string[][][], execParams: ExecParams) {
        if (args.length) {
            await Bluebird.map(args[0], async parg => {
                await Bluebird.mapSeries(parg, async sarg => {
                    await this.tasks.find(t => t.name === sarg)?.exec(args.slice(1), execParams);
                });
            });

            // const tasks: Task[][] = [];
            // for (const parg of args[0].split('|')) {
            //     const sTasks = _.compact(parg.split(',').map(sarg => this.tasks.find(t => t.name === sarg)));
            //     if (sTasks.length)
            //         tasks.push(sTasks);
            // }

            // await Bluebird.map(tasks, async taskGroup => {
            //     await Bluebird.mapSeries(taskGroup, async task => {
            //         await task.exec(args.slice(1));
            //     });
            // });
        }
        else {
            if (this.parallel) {
                if (this.actions.length)
                    await Bluebird.map(this.actions, action => action.exec(execParams));
                else
                    await Bluebird.map(this.tasks, task => task.exec([], execParams));
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
    }

    public async resolveVariables(): Promise<Record<string, string | null>> {
        const pathVariables: Record<string, string> = {};
        for (const key in this.pathVariables)
            pathVariables[key] = Path.resolve(this.#parentConfig?.path ?? '.', this.pathVariables[key])

        return {
            ...this.variables,
            ...pathVariables,
            ...await this.parentTask?.resolveVariables(),
            ...await this.parentConfig?.resolveVariables()
        }
    }
}

export abstract class AAction {
    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    #parentTask?: Task;
    public get parentTask() {
        return this.#parentTask;
    }

    public static parse(value: unknown) {
        return this.fromSchema(ActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ActionSchema>) {
        if (value.type === 'exec')
            return ExecAction.fromSchema(value);
        else if (value.type === 'delegate')
            return DelegateAction.fromSchema(value);
        else if (value.type === 'watch')
            return WatchAction.fromSchema(value);
        else if (value.type === 'delegate.local')
            return LocalDelegateAction.fromSchema(value);
        else if (value.type === 'copy')
            return CopyAction.fromSchema(value);
        else if (value.type === 'fs.empty')
            return EmptyAction.fromSchema(value);
        else if (value.type === 'variables.reload')
            return ReloadVariablesAction.fromSchema(value);
        else
            throw new Error('Could not parse action schema');
    }

    public register(parentConfig: Config, parentTask?: Task) {
        this.#parentConfig = parentConfig;
        this.#parentTask = parentTask;

        return this;
    }

    public abstract exec(execParams: ExecParams): void | Promise<void>;
}

export interface ReloadVariablesActionParams {
}
export class ReloadVariablesAction extends AAction {
    public readonly type = 'variables.reload';

    public static parse(value: unknown) {
        return this.fromSchema(ReloadVariablesActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ReloadVariablesActionSchema>) {
        return new ReloadVariablesAction({
            ...value
        });
    }

    public constructor(params: ReloadVariablesActionParams) {
        super();
    }

    public async exec(execParams: ExecParams) {
    }
}

export interface ExecCommand {
    platforms?: string[];
    cmd?: string;
}

export interface ExecActionParams {
    cmd?: ExecAction['cmd'];
    requiredVariables?: ExecAction['requiredVariables'];
    ignoreExitCode?: ExecAction['ignoreExitCode'];
    platforms?: ExecAction['platforms'];
    commands?: ExecAction['commands'];
}
export class ExecAction extends AAction {
    public readonly type = 'exec';
    public cmd?: string;
    public requiredVariables: string[]
    public ignoreExitCode: boolean;
    public platforms?: string[];
    public commands: Array<{
        platforms?: string[];
        cmd?: string;
    }>;

    public static parse(value: unknown) {
        return this.fromSchema(ExecActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ExecActionSchema>) {
        return new ExecAction({
            ...value,
            commands: value.commands?.map(({ platforms, cmd }) => ({
                platforms: platforms,
                cmd: cmd
            }))
        });
    }

    public constructor(params: ExecActionParams) {
        super();

        this.cmd = params.cmd;
        this.requiredVariables = params.requiredVariables ?? [];
        this.ignoreExitCode = params.ignoreExitCode ?? false;
        this.platforms = params.platforms;
        this.commands = params.commands ?? [];
    }

    public async exec(execParams: ExecParams) {
        const vars = {
            ...await (this.parentTask ?? this.parentConfig)?.resolveVariables(),
            ...execParams.vars
        }

        for (const requiredVariable of this.requiredVariables) {
            if (!vars[requiredVariable])
                throw new Error(`Required variable ${requiredVariable} not defined`);
        }

        const processCmd = async (command: ExecCommand) => {
            if (command.platforms && command.platforms.indexOf(OS.platform()) < 0)
                return;

            if (command.cmd) {
                await exec(_.template(command.cmd)(vars), {
                    cwd: this.parentConfig?.path,
                    stdout: process.stdout,
                    ignoreExitCode: this.ignoreExitCode
                });
            }
        }

        await processCmd(this);
        for (const command of this.commands)
            await processCmd(command);
    }
}

export interface LocalDelegateActionParams {
    relative?: LocalDelegateAction['relative'];
    parallel?: LocalDelegateAction['parallel'];
    variables?: LocalDelegateAction['variables'];
    task: LocalDelegateAction['task'];
}
export class LocalDelegateAction extends AAction {
    public readonly type = 'delegate.local';
    public relative: boolean;
    public parallel: boolean;
    public variables: Record<string, string>;
    public task: string[];

    public static parse(value: unknown) {
        return this.fromSchema(LocalDelegateActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof LocalDelegateActionSchema>) {
        const task = _.isString(value.task) ? [ value.task ] : value.task;

        return new LocalDelegateAction({
            ...value,
            task
        });
    }

    public constructor(params: LocalDelegateActionParams) {
        super();

        this.relative = params.relative ?? false;
        this.parallel = params.parallel ?? false;
        this.variables = params.variables ?? {};
        this.task = params.task;
    }

    public async exec(execParams: ExecParams) {
        const parsedArgs = parseArgs(this.task);

        const vars = {
            ...await (this.parentTask ?? this.parentConfig)?.resolveVariables(),
            ...execParams.vars
        }

        const forwardedVars: Record<string, string> = {};
        for (const key in this.variables)
            forwardedVars[key] = _.template(this.variables[key])(vars);

        await (this.parallel ? Bluebird.map : Bluebird.mapSeries)(parsedArgs, a => (this.relative ? this.parentTask : this.parentConfig)?.exec(a, {
            vars: {
                ...execParams.vars,
                ...forwardedVars
            }
        }));
    }
}

export interface DelegateActionParams {
    task?: DelegateAction['task'];
    dependencies?: DelegateAction['dependencies'];
    included?: DelegateAction['included'];
    parallel: DelegateAction['parallel'];
    variables?: DelegateAction['variables'];
}
export class DelegateAction extends AAction {
    public readonly type = 'delegate';
    public task?: string[];
    public dependencies: Record<string, string[]>;
    public included: Record<string, string[][]>;
    public parallel: boolean;
    public variables: Record<string, string>;

    public static parse(value: unknown) {
        return this.fromSchema(DelegateActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof DelegateActionSchema>) {
        const task = _.isString(value.task) ? [ value.task ] : value.task;

        return new DelegateAction({
            ...value,
            parallel: value.parallel ?? false,
            included: value.included && _.transform(value.included, (result, value, key) => {
                result[key] = _.isArray(value) ? value.map(v => v.split(',')) : [ value.split(',') ];
            }, {} as Record<string, string[][]>),
            task
        });
    }

    public constructor(params: DelegateActionParams) {
        super();

        this.task = params.task;
        this.dependencies = params.dependencies ?? {};
        this.included = params.included ?? {};
        this.parallel = params.parallel;
        this.variables = params.variables ?? {};
    }

    public async exec(execParams: ExecParams) {
        const parentConfig = this.parentConfig;
        if (!parentConfig)
            return;

        let configs: Array<Config> = [];

        for await (const config of parentConfig.resolveConfigs())
            configs.push(config);

        const dependencies = {
            ...this.dependencies,
            ...this.parentConfig?.dependencies
        }

        if (!_.isEmpty(dependencies)) {
            const pathspecs = configs.map(c => c.labels['cohesion:pathspec'][0]);

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
            configs = _(configs)
                .orderBy(c => sortedPathspecs.findIndex(p => p === c.labels['cohesion:pathspec'][0]))
                .filter(config => _.isEmpty(this.included) || _.every(this.included, (value, key) => _.some(value, v => v.every(vv => config.labels[key]?.indexOf(vv) >= 0))))
                .value();

            // configs = Toposort(explodedDependencies).reverse()
            //     .map(p => configs.find(c => c.labels['cohesion:pathspec'] === p) as Config)
            //     .filter(config => _.isEmpty(this.included) || _.some(this.included, (value, key) => _.some(value, v => v.every(vv => config.labels[key] === vv))));
        }
        else {
            configs = _(configs)
                .filter(config => _.isEmpty(this.included) || _.every(this.included, (value, key) => _.some(value, v => v.every(vv => config.labels[key]?.indexOf(vv) >= 0))))
                .value();
        }

        const vars = {
            ...await (this.parentTask ?? this.parentConfig)?.resolveVariables(),
            ...execParams.vars
        }

        const forwardedVars: Record<string, string> = {};
        for (const key in this.variables)
            forwardedVars[key] = _.template(this.variables[key])(vars);

        const tasks = this.task ?? (this.parentTask ? [ this.parentTask.name ] : undefined);
        if (!tasks)
            throw new Error('No delegated task defined');

        for (const task of tasks) {
            const parsedArgs = parseArgs(task);

            if (this.parallel) {
                await Bluebird.map(configs, config => config.exec(parsedArgs, {
                    vars: {
                        ...execParams.vars,
                        ...forwardedVars
                    }
                }));
            }
            else {
                await Bluebird.mapSeries(configs, config => config.exec(parsedArgs, {
                    vars: {
                        ...execParams.vars,
                        ...forwardedVars
                    }
                }));
            }
        }
    }
}

export interface WatchActionParams {
    patterns?: WatchAction['patterns'];
    actions?: WatchAction['actions'];
    parallel: WatchAction['parallel'];
}
export class WatchAction extends AAction {
    public readonly type = 'watch';
    public patterns: string[];
    public actions: Action[];
    public parallel: boolean;

    public static parse(value: unknown) {
        return this.fromSchema(WatchActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof WatchActionSchema>): WatchAction {
        return new WatchAction({
            ...value,
            parallel: value.parallel ?? false,
            actions: value.actions?.map(i => AAction.fromSchema(i))
        });
    }

    public constructor(params: WatchActionParams) {
        super();

        this.patterns = params.patterns ?? [];
        this.actions = params.actions ?? [];
        this.parallel = params.parallel;
    }

    public register(parentConfig: Config, parentTask?: Task) {
        super.register(parentConfig, parentTask);
        this.actions.forEach(a => a.register(parentConfig, parentTask));

        return this;
    }

    public async exec(execParams: ExecParams) {
        const execute = _.debounce(async () => {
            if (this.parallel) {
                await Bluebird.map(this.actions, action => action.exec(execParams));
            }
            else {
                for (const action of this.actions)
                    await action.exec(execParams);
            }
        }, 500);

        const matches = await Bluebird.map(Globby(this.patterns, { cwd: this.parentConfig?.path, absolute: true }), async path => ({
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
    }
}

export interface CopyActionParams {
    source: CopyAction['source'];
    destination: CopyAction['destination'];
}
export class CopyAction extends AAction {
    public readonly type = 'copy';
    public source: string;
    public destination: string;

    public static parse(value: unknown) {
        return this.fromSchema(CopyActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof CopyActionSchema>): CopyAction {
        return new CopyAction({
            ...value
        });
    }

    public constructor(params: CopyActionParams) {
        super();

        this.source = params.source;
        this.destination = params.destination;
    }

    public async exec(execParams: ExecParams) {
        await FS.copyFile(this.source, this.destination);
        console.log(`Copied ${this.source} to ${this.destination}`);

        // if (this.destination.endsWith('/') || this.destination.endsWith('\\')) {
        //     const matches = await Globby(this.source, { cwd: this.parentTask?.parentConfig?.path });
        //     await Bluebird.map(matches, async match => FS.copyFile(match, this.destination))
        // }
        // else {
            
        // }
    }
}

export interface EmptyActionParams {
    path: EmptyAction['path'];
}
export class EmptyAction extends AAction {
    public readonly type = 'fs.empty';
    public path: string;

    public static parse(value: unknown) {
        return this.fromSchema(EmptyActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof EmptyActionSchema>): EmptyAction {
        return new EmptyAction({
            ...value
        });
    }

    public constructor(params: EmptyActionParams) {
        super();

        this.path = params.path;
    }

    public async exec(execParams: ExecParams) {
        const path = Path.resolve(this.parentConfig?.path ?? '.', this.path);

        await FS.emptyDir(path);
        console.log(`Emptied ${path}`);
    }
}

export type Action = ExecAction | DelegateAction | WatchAction | LocalDelegateAction | CopyAction | EmptyAction | ReloadVariablesAction;

export async function loadConfig(path: string, params: { parentConfig?: Config, initializer?: ConfigInitializer } = {}) {
    const resolvedPath = Path.resolve(path);

    return FS.readFile(path, 'utf8')
        .then(content => Yaml.load(content))
        .then(hash => Config.parse(hash).register(Path.dirname(resolvedPath), params));
}
