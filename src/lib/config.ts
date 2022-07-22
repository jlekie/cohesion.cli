import * as _ from 'lodash';
import * as Bluebird from 'bluebird';

import * as Zod from 'zod';

import * as FS from 'fs-extra';
import * as Yaml from 'js-yaml';
import * as Globby from 'globby';
import * as Path from 'path';
import * as Minimatch from 'minimatch';

import * as Toposort from 'toposort';

import { exec } from './misc';

interface ConfigInitializer {
    name?: (config: Config) => string;
}

export type ActionSchema = ExecActionSchema | DelegateActionSchema | WatchActionSchema | LocalDelegateActionSchema;
export const ActionSchema: Zod.ZodType<ActionSchema> = Zod.lazy(() => Zod.discriminatedUnion('type', [
    ExecActionSchema,
    DelegateActionSchema,
    WatchActionSchema,
    LocalDelegateActionSchema
]));

export interface ExecActionSchema {
    type: 'exec';
    cmd: string;
}
export const ExecActionSchema = Zod.object({
    type: Zod.literal('exec'),
    cmd: Zod.string()
});

export interface LocalDelegateActionSchema {
    type: 'delegate.local';
    task: string;
}
export const LocalDelegateActionSchema = Zod.object({
    type: Zod.literal('delegate.local'),
    task: Zod.string()
});

export interface DelegateActionSchema {
    type: 'delegate';
    dependencies?: Record<string, string[]>;
    included?: Record<string, string>;
    task: string;
    parallel?: boolean;
}
export const DelegateActionSchema = Zod.object({
    type: Zod.literal('delegate'),
    dependencies: Zod.record(Zod.string(), Zod.string().array()).optional(),
    included: Zod.record(Zod.string(), Zod.string()).optional(),
    task: Zod.string(),
    parallel: Zod.boolean().optional(),
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

export interface TaskSchema {
    name: string;
    parallel?: boolean;
    actions?: Zod.infer<typeof ActionSchema>[];
    tasks?: TaskSchema[];
}
export const TaskSchema: Zod.ZodType<TaskSchema> = Zod.lazy(() => Zod.object({
    name: Zod.string(),
    parallel: Zod.boolean().optional(),
    actions: ActionSchema.array().optional(),
    tasks: TaskSchema.array().optional()
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

export const ConfigSchema = Zod.object({
    modules: Zod.union([
        ModuleReferenceSchema,
        ModuleReferenceSchema.array()
    ]).optional(),
    labels: Zod.record(Zod.string(), Zod.string()).optional(),
    tags: Zod.string().array().optional(),
    tasks: TaskSchema.array().optional()
});

export interface ConfigParams {
    modules?: Config['modules'];
    labels?: Config['labels'];
    tags?: Config['tags'];
    tasks?: Config['tasks'];
}
export class Config {
    public modules: ModuleReference[];
    public labels: Record<string, string>;
    public tags: string[];
    public tasks: Task[];

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
            tasks: value.tasks?.map(i => Task.fromSchema(i))
        });

        return config;
    }

    public constructor(params: ConfigParams) {
        this.modules = params.modules ?? [];
        this.labels = params.labels ?? {};
        this.tags = params.tags ?? [];
        this.tasks = params.tasks ?? [];
    }

    public register(path: string, { parentConfig, initializer }: { parentConfig?: Config, initializer?: ConfigInitializer } = {}) {
        this.#path = path;
        this.#parentConfig = parentConfig;
        this.#initializer = initializer;
        // this.#name = initializer?.name?.(this);
        this.#name = Path.basename(path);

        this.tasks.forEach(t => t.register(this));

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
                'cohesion:pathspec': Path.relative(this.path ?? '.', config.path ?? '.').replace('\\', '/')
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

    public async exec(args: string[]) {
        const task = this.tasks.find(t => t.name === args[0]);
        if (!task)
            return;

        await task.exec(args.slice(1));
        // const task = args.slice(1).reduce((task, value) => task?.tasks.find(t => t.name === value), this.tasks.find(t => t.name === args[0]));
        // if (!task)
        //     return;

        // for (const action of task.actions)
        //     await action.exec();
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
}
export class Task {
    public name: string;
    public parallel: boolean;
    public actions: Action[];
    public tasks: Task[];

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
            actions: value.actions?.map(i => AAction.fromSchema(i)),
            tasks: value.tasks?.map(i => Task.fromSchema(i))
        });
    }

    public constructor(params: TaskParams) {
        this.name = params.name;
        this.parallel = params.parallel;
        this.actions = params.actions ?? [];
        this.tasks = params.tasks ?? [];
    }

    public register(parentConfig: Config, parentTask?: Task) {
        this.#parentConfig = parentConfig;
        this.#parentTask = parentTask;

        this.tasks.forEach(t => t.register(parentConfig, this));
        this.actions.forEach(a => a.register(this));

        return this;
    }

    public async exec(args: string[] = []) {
        if (args.length) {
            const task = this.tasks.find(t => t.name === args[0]);
            if (!task)
                throw new Error(`Could not find matching command ${args}`)

            task.exec(args.slice(1));
        }
        else {
            if (this.parallel) {
                if (this.actions.length)
                    await Bluebird.map(this.actions, action => action.exec());
                else
                    await Bluebird.map(this.tasks, task => task.exec());
            }
            else {
                if (this.actions.length) {
                    for (const action of this.actions)
                        await action.exec();
                }
                else {
                    for (const task of this.tasks)
                        await task.exec();
                }
            }
        }
    }
}

export abstract class AAction {
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
        else
            throw new Error('Could not parse action schema');
    }

    public register(parentTask: Task) {
        this.#parentTask = parentTask;

        return this;
    }

    public abstract exec(): void | Promise<void>;
}

export interface ExecActionParams {
    cmd: ExecAction['cmd'];
}
export class ExecAction extends AAction {
    public readonly type = 'exec';
    public cmd: string;

    public static parse(value: unknown) {
        return this.fromSchema(ExecActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof ExecActionSchema>) {
        return new ExecAction({
            ...value
        });
    }

    public constructor(params: ExecActionParams) {
        super();

        this.cmd = params.cmd;
    }

    public async exec() {
        await exec(this.cmd, {
            cwd: this.parentTask?.parentConfig?.path,
            stdout: process.stdout,
            // label: this.cmd
        });
    }
}

export interface LocalDelegateActionParams {
    task: DelegateAction['task'];
}
export class LocalDelegateAction extends AAction {
    public readonly type = 'delegate.local';
    public task: string;

    public static parse(value: unknown) {
        return this.fromSchema(LocalDelegateActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof LocalDelegateActionSchema>) {
        return new LocalDelegateAction({
            ...value
        });
    }

    public constructor(params: LocalDelegateActionParams) {
        super();

        this.task = params.task;
    }

    public async exec() {
        const parentConfig = this.parentTask?.parentConfig;
        if (!parentConfig)
            return;

        await parentConfig.exec(this.task.split(' '));
    }
}

export interface DelegateActionParams {
    task: DelegateAction['task'];
    dependencies?: DelegateAction['dependencies'];
    included?: DelegateAction['included'];
    parallel: DelegateAction['parallel'];
}
export class DelegateAction extends AAction {
    public readonly type = 'delegate';
    public task: string;
    public dependencies: Record<string, string[]>
    public included: Record<string, string>;
    public parallel: boolean;

    public static parse(value: unknown) {
        return this.fromSchema(DelegateActionSchema.parse(value));
    }
    public static fromSchema(value: Zod.infer<typeof DelegateActionSchema>) {
        return new DelegateAction({
            ...value,
            parallel: value.parallel ?? false
        });
    }

    public constructor(params: DelegateActionParams) {
        super();

        this.task = params.task;
        this.dependencies = params.dependencies ?? {};
        this.included = params.included ?? {};
        this.parallel = params.parallel;
    }

    public async exec() {
        const parentConfig = this.parentTask?.parentConfig;
        if (!parentConfig)
            return;

        let configs: Array<Config> = [];

        const execPromises = [];
        for await (const config of parentConfig.resolveConfigs()) {
            if (!_.isEmpty(this.included) && !_.some(this.included, (value, key) => config.labels[key] == value))
                continue;

            configs.push(config);

            // const execPromise = config.exec(this.task.split(' '));
            // execPromises.push(execPromise);

            // if (!this.parallel)
            //     await execPromise;
        }

        if (!_.isEmpty(this.dependencies)) {
            const pathspecs = configs.map(c => c.labels['cohesion:pathspec']);

            const explodedDependencies: [string, string][] = [];
            for (const key in this.dependencies) {
                const keyMatches = pathspecs.filter(c => Minimatch(c, key));
                const valueMatches = pathspecs.filter(c => this.dependencies[key].some(v => Minimatch(c, v)));
    
                for (const keyMatch of keyMatches)
                    for (const valueMatch of valueMatches)
                        explodedDependencies.push([ keyMatch, valueMatch ]);
            }
            // console.log(explodedDependencies)
    
            configs = Toposort(explodedDependencies).reverse().map(p => configs.find(c => c.labels['cohesion:pathspec'] === p) as Config);
        }

        if (this.parallel)
            await Bluebird.map(configs, config => config.exec(this.task.split(' ')));
        else
            await Bluebird.mapSeries(configs, config => config.exec(this.task.split(' ')));

        // await Promise.all(execPromises);
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

    public register(parentTask: Task) {
        super.register(parentTask);
        this.actions.forEach(a => a.register(parentTask));

        return this;
    }

    public async exec() {
        const execute = _.debounce(async () => {
            if (this.parallel) {
                await Bluebird.map(this.actions, action => action.exec());
            }
            else {
                for (const action of this.actions)
                    await action.exec();
            }
        }, 500);

        const matches = await Bluebird.map(Globby(this.patterns, { cwd: this.parentTask?.parentConfig?.path, absolute: true }), async path => ({
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

export type Action = ExecAction | DelegateAction | WatchAction | LocalDelegateAction;

export async function loadConfig(path: string, params: { parentConfig?: Config, initializer?: ConfigInitializer } = {}) {
    const resolvedPath = Path.resolve(path);

    return FS.readFile(path, 'utf8')
        .then(content => Yaml.load(content))
        .then(hash => Config.parse(hash).register(Path.dirname(resolvedPath), params));
}
