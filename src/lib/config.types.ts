import * as OS from 'os';
import * as Url from 'url';

import Axios from 'axios';

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

import * as Stream from 'stream';
import * as Chalk from 'chalk';

import * as Tmp from 'tmp-promise';

import { Type } from '@sinclair/typebox';
import { typeDef, parsedTypeDef, compiledParsedTypeDef } from './types';

// import * as Types from './types';

import { exec } from './misc';

interface ConfigInitializer {
    name?: (config: Config) => string;
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

export interface ExecParams {
    stdout?: Stream.Writable;
    label?: string;
    vars: Record<string, string>;
}

export const VariableFileReferenceTypeDef = typeDef('parsed', Type.Union([
    Type.String(),
    Type.Object({
        path: Type.String(),
        prefix: Type.Optional(Type.String())
    })
]), value => {
    if (typeof value === 'string') {
        return new VariableFileReference({
            path: value
        });
    }
    else {
        return new VariableFileReference({
            ...value
        });
    }
});

export const ModuleReferenceTypeDef = typeDef('parsed', Type.Union([
    Type.String(),
    Type.Object({
        patterns: Type.Union([
            Type.String(),
            Type.Array(Type.String())
        ]),
        labels: Type.Optional(Type.Record(Type.String(), Type.String()))
    })
]), value => {
    if (typeof value === 'string') {
        return new ModuleReference({
            patterns: [ value ]
        });
    }
    else {
        return new ModuleReference({
            ...value,
            patterns: Array.isArray(value.patterns) ? value.patterns : [ value.patterns ]
        });
    }
});

export const ActionTypeDef = typeDef('parsed', Type.Object({
    type: Type.String()
}), value => {
    return new Action({
        type: value.type,
        options: _.omit(value, 'type')
    });
});

export const PluginTypeDef = typeDef('parsed', Type.Object({
    module: Type.String()
}), value => {
    return new Plugin({
        module: value.module,
        options: _.omit(value, 'module')
    });
});

const TaskType = Type.Recursive(Task => Type.Object({
    name: Type.String(),
    parallel: Type.Optional(Type.Boolean()),
    actions: Type.Optional(Type.Array(Type.Union([ ActionTypeDef.Schema(), Type.String() ]))),
    tasks: Type.Optional(Type.Array(Task)),
    variables: Type.Optional(Type.Record(Type.String(), Type.Union([ Type.String(), Type.Null() ]))),
    pathVariables: Type.Optional(Type.Record(Type.String(), Type.String()))
}));
export const TaskTypeDef = compiledParsedTypeDef<typeof TaskType, Task>(TaskType, (value, TT) => {
    return new Task({
        ...value,
        parallel: value.parallel ?? false,
        actions: value.actions?.map(i => _.isString(i) ? new Action({ type: 'exec', options: { cmd: i } }) : ActionTypeDef.parse(i)),
        tasks: value.tasks?.map(i => TT.checkAndParse(i))
    });
});

export const ConfigTypeDef = typeDef('compiledParsed', Type.Object({
    modules: Type.Optional(Type.Union([
        ModuleReferenceTypeDef.Schema(),
        Type.Array(ModuleReferenceTypeDef.Schema())
    ])),
    labels: Type.Optional(Type.Record(Type.String(), Type.Union([ Type.String(), Type.Array(Type.String()) ]))),
    tags: Type.Optional(Type.Array(Type.String())),
    tasks: Type.Optional(Type.Array(TaskTypeDef.Schema())),
    actions: Type.Optional(Type.Array(Type.Union([ ActionTypeDef.Schema(), Type.String() ]))),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    variables: Type.Optional(Type.Record(Type.String(), Type.Union([ Type.String(), Type.Null() ]))),
    pathVariables: Type.Optional(Type.Record(Type.String(), Type.String())),
    variableFiles: Type.Optional(Type.Array(VariableFileReferenceTypeDef.Schema())),
    plugins: Type.Optional(Type.Array(PluginTypeDef.Schema()))
}), value => {
    return new Config({
        ...value,
        modules: value.modules ? (_.isArray(value.modules) ? value.modules.map(m => ModuleReferenceTypeDef.parse(m)) : [ ModuleReferenceTypeDef.parse(value.modules) ]) : undefined,
        tasks: value.tasks?.map(i => TaskTypeDef.parse(i)),
        actions: value.actions?.map(i => _.isString(i) ? new Action({ type: 'exec', options: { cmd: i } }) : ActionTypeDef.parse(i)),
        variableFiles: value.variableFiles?.map(i => VariableFileReferenceTypeDef.parse(i)),
        labels: value.labels ? _.transform(value.labels, (memo, value, key) => memo[key] = _.isArray(value) ? value : [ value ], {} as Record<string, string[]>) : undefined,
        plugins: value.plugins?.map(i => PluginTypeDef.parse(i))
    });
});

export interface VariableFileReferenceParams {
    path: VariableFileReference['path'];
    prefix?: VariableFileReference['prefix'];
}
export class VariableFileReference {
    public readonly path: string;
    public readonly prefix?: string;

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    // public static parse(value: unknown) {
    //     return this.fromSchema(VariableFileReferenceSchema.parse(value));
    // }
    // public static fromSchema(value: typeof Types.VariableFileReference.StaticType) {
    //     if (_.isString(value)) {
    //         return new VariableFileReference({
    //             path: value
    //         });
    //     }
    //     else {
    //         const variableFileReference: VariableFileReference = new VariableFileReference({
    //             ...value
    //         });
    
    //         return variableFileReference;
    //     }
    // }

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
    plugins?: Config['plugins'];
}
export class Config {
    public readonly modules: ModuleReference[];
    public readonly labels: Record<string, string[]>;
    public readonly tags: string[];
    public readonly tasks: Task[];
    public readonly actions: Action[];
    public readonly dependencies: Record<string, string[]>;
    public readonly variables: Record<string, string | null>;
    public readonly pathVariables: Record<string, string>;
    public readonly variableFiles: VariableFileReference[];
    public readonly plugins: Plugin[];

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

    // public static parse(value: unknown) {
    //     if (!Types.Config.check(value))
    //         throw new Error('config parse failure', { cause: Types.Config.errors(value) })

    //     return this.fromSchema(value);
    // }
    // public static fromSchema(value: typeof Types.Config.StaticType) {
    //     const config: Config = new Config({
    //         ...value,
    //         modules: value.modules ? (_.isArray(value.modules) ? value.modules.map(m => Types.ModuleReference.parse(m)) : [ Types.ModuleReference.parse(value.modules) ]) : undefined,
    //         tasks: value.tasks?.map(i => Task.fromSchema(i)),
    //         actions: value.actions?.map(i => _.isString(i) ? new Action({ type: 'exec' }) : Action.fromSchema(i)),
    //         variableFiles: value.variableFiles?.map(i => Types.VariableFileReference.parse(i)),
    //         labels: value.labels ? _.transform(value.labels, (memo, value, key) => memo[key] = _.isArray(value) ? value : [ value ], {} as Record<string, string[]>) : undefined,
    //         plugins: value.plugins?.map(i => Plugin.fromSchema(i))
    //     });

    //     return config;
    // }

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
        this.plugins = params.plugins ?? [];
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
                initializer: this.#initializer,
                transform: (value, path) => ({
                    ...value,
                    labels: {
                        ...value.labels,
                        ...matchedFiles[match],
                        'cohesion:pathspec': [ Path.relative(this.path ?? '.', path ?? '.').replace('\\', '/') ]
                    }
                })
            });
            // config.labels = {
            //     ...config.labels,
            //     ...matchedFiles[match],
            //     'cohesion:pathspec': [ Path.relative(this.path ?? '.', config.path ?? '.').replace('\\', '/') ]
            // };

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
}

export interface ModuleReferenceParams {
    patterns: ModuleReference['patterns'];
    labels?: ModuleReference['labels'];
}
export class ModuleReference {
    public readonly patterns: string[];
    public readonly labels: Record<string, string>;

    // public static parse(value: unknown) {
    //     return this.fromSchema(ModuleReferenceSchema.parse(value));
    // }
    // public static fromSchema(value: typeof Types.ModuleReference.StaticType) {
    //     if (_.isString(value)) {
    //         return new ModuleReference({
    //             patterns: [ value ]
    //         });
    //     }
    //     else {
    //         return new ModuleReference({
    //             ...value,
    //             patterns: _.isArray(value.patterns) ? value.patterns : [ value.patterns ]
    //         });
    //     }
    // }

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
    public readonly name: string;
    public readonly parallel: boolean;
    public readonly actions: Action[];
    public readonly tasks: Task[];
    public readonly variables: Record<string, string | null>;
    public readonly pathVariables: Record<string, string>;

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    #parentTask?: Task;
    public get parentTask() {
        return this.#parentTask;
    }

    // public static parse(value: unknown) {
    //     return this.fromSchema(TaskSchema.parse(value));
    // }
    // public static fromSchema(value: typeof Types.Task.StaticType): Task {
    //     return new Task({
    //         ...value,
    //         parallel: value.parallel ?? false,
    //         actions: value.actions?.map(i => _.isString(i) ? new Action({ type: 'exec' }) : Action.fromSchema(i)),
    //         tasks: value.tasks?.map(i => Task.fromSchema(i))
    //     });
    // }

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

    public async resolveVariables(): Promise<Record<string, string | null>> {
        const pathVariables: Record<string, string> = {};
        for (const key in this.pathVariables)
            pathVariables[key] = Path.resolve(this.#parentConfig?.path ?? '.', this.pathVariables[key])

        return {
            ...this.variables,
            ...pathVariables,
            ...await this.parentTask?.resolveVariables(),
            ...await this.parentConfig?.resolveVariables()
        };
    }

    public resolveFqn(): string {
        return this.parentTask ? `${this.parentTask.resolveFqn()}.${this.name}` : this.name;
    }
}

export interface ActionParams {
    type: Action['type'];
    options?: Record<string, unknown>;
}
export class Action {
    public readonly type: string;
    public readonly options: Record<string, unknown>;

    #parentConfig?: Config;
    public get parentConfig() {
        return this.#parentConfig;
    }

    #parentTask?: Task;
    public get parentTask() {
        return this.#parentTask;
    }

    // public static parse(value: unknown) {
    //     return this.fromSchema(ActionSchema.parse(value));
    // }
    // public static fromSchema(value: typeof Types.Action.StaticType & Record<string, unknown>) {
    //     return new Action({
    //         type: value.type,
    //         options: _.omit(value, 'type')
    //     });
    // }

    public constructor(params: ActionParams) {
        this.type = params.type;
        this.options = params.options ?? {};
    }

    public register(parentConfig: Config, parentTask?: Task) {
        this.#parentConfig = parentConfig;
        this.#parentTask = parentTask;

        return this;
    }
}

export interface PluginParams {
    module: Plugin['module'];
    options?: Plugin['options'];
}
export class Plugin {
    public readonly module: string;
    public readonly options: Record<string, unknown>;

    // public static parse(value: unknown) {
    //     return this.fromSchema(ActionSchema.parse(value));
    // }
    // public static fromSchema(value: typeof Types.Plugin.StaticType & Record<string, unknown>) {
    //     return new Plugin({
    //         module: value.module,
    //         options: _.omit(value, 'module')
    //     });
    // }

    public constructor(params: PluginParams) {
        this.module = params.module;
        this.options = params.options ?? {};
    }
}

export async function loadConfig(uri: string, { transform, ...registerParams }: { parentConfig?: Config, initializer?: ConfigInitializer, transform?: (value: typeof ConfigTypeDef.StaticType, path: string) => typeof ConfigTypeDef.StaticType } = {}) {
    if (Zod.string().url().safeParse(uri).success) {
        const [ protocol, path ] = uri.split('://');

        switch (protocol) {
            case 'http':
            case 'https': {
                return Axios.get(uri)
                    .then(response => Yaml.load(response.data))
                    .then(hash => {
                        if (!ConfigTypeDef.check(hash))
                            throw new Error('config parse failure', { cause: ConfigTypeDef.errors(hash) });

                        return transform ? transform(hash, process.cwd()) : hash;
                    })
                    .then(value => ConfigTypeDef.parse(value).register(process.cwd(), registerParams));
            }
            case 'file': {
                const resolvedPath = Path.resolve(path);

                return FS.readFile(resolvedPath, 'utf8')
                    .then(content => Yaml.load(content))
                    .then(hash => {
                        if (!ConfigTypeDef.check(hash))
                            throw new Error('config parse failure', { cause: ConfigTypeDef.errors(hash) });

                        return transform ? transform(hash, Path.dirname(resolvedPath)) : hash;
                    })
                    .then(value => ConfigTypeDef.parse(value).register(Path.dirname(resolvedPath), registerParams));
            }
            default:
                throw new Error(`unsupported config URI [${uri}]`);
        }
    }
    else {
        const resolvedPath = Path.resolve(uri);

        return FS.readFile(resolvedPath, 'utf8')
            .then(content => Yaml.load(content))
            .then(hash => {
                if (!ConfigTypeDef.check(hash))
                    throw new Error('config parse failure', { cause: ConfigTypeDef.errors(hash) });

                return transform ? transform(hash, Path.dirname(resolvedPath)) : hash;
            })
            .then(value => ConfigTypeDef.parse(value).register(Path.dirname(resolvedPath), registerParams));
    }
}
