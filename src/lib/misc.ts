import * as _ from 'lodash';
import * as Chalk from 'chalk';

import * as ChildProcess from 'child_process';
import * as Stream from 'stream';

import * as Path from 'path';

export type RequiredKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? never : P }[keyof T];
export type OptionalKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? P : never }[keyof T];

export type Lazy<T> = {
    [P in RequiredKeys<T>]-?: () => Required<T>[P]
} & {
    [P in OptionalKeys<T>]+?: () => Required<T>[P]
}

export interface ExecOptions {
    cwd?: string;
    stdout?: Stream.Writable;
    dryRun?: boolean;
    echo?: boolean;
    ignoreExitCode?: boolean;
    label?: string;
}

class Test extends Stream.Transform {
    private readonly label: string;

    private inProgress: boolean = false;

    public constructor(label: string, options?: Stream.TransformOptions) {
        super(options)

        this.label = label;
    }

    public override _transform(chunk: any, encoding: BufferEncoding, callback: Stream.TransformCallback): void {
        // this.push(chunk.toString().split(/(?:\r\n|\r|\n)/g).map((p: string) => this.label + p).join('\n'))
        this.push((!this.inProgress ? this.label : '') + chunk.toString().replace(/(?:\r\n|\r|\n)/gm, `\n${this.label}: `));
        this.inProgress = true;

        callback();
    }
}

export async function exec(cmd: string, { cwd, stdout, dryRun, echo = true, ignoreExitCode = false, label }: ExecOptions = {}) {
    echo && stdout?.write(Chalk.gray(`${label ? label + ' ' : ''}${Chalk.cyan.bold(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

    if (dryRun)
        return;

    const env = cmd.startsWith('yarn')
        ? _.omit(process.env, 'NODE_OPTIONS', 'INIT_CWD' , 'PROJECT_CWD', 'PWD', 'npm_package_name', 'npm_package_version', 'npm_config_user_agent', 'npm_execpath', 'npm_node_execpath', 'BERRY_BIN_FOLDER')
        : process.env;
    // const env = process.env;
    const proc = ChildProcess.spawn(cmd, { stdio: stdout && label ? [ 'inherit', 'pipe', 'pipe' ] : 'inherit', shell: true, cwd, env: { ...env, 'FORCE_COLOR': '1' } });
    // const proc = ChildProcess.spawn(cmd, { stdio: 'inherit', shell: true, cwd, env });

    return new Promise<void>((resolve, reject) => {
        // proc.stdout?.on('data', d => stdout?.write(`${label ? Chalk.cyan('[' + label + ']') + ' ' : ''}${d}`));
        // proc.stderr?.on('data', d => stdout?.write(`${label ? Chalk.cyan('[' + label + ']') + ' ' : ''}${d}`));

        // const test = new Test();
        stdout && label && proc.stdout?.pipe(new Test(label)).pipe(stdout)
        stdout && label && proc.stderr?.pipe(new Test(label)).pipe(stdout)

        // proc.stdout?.on('data', d => stdout?.write(d));
        // proc.stderr?.on('data', d => stdout?.write(d));

        proc.on('close', (code) => code !== 0 && !ignoreExitCode ? reject(new Error(`${cmd} <${Path.resolve(cwd ?? '.')}> Exited with code ${code}`)) : resolve());
        proc.on('error', (err) => reject(err));
    }).catch(err => {
        throw new Error(`Shell exec failed: ${err}`);
    });
}
export async function execCmd(cmd: string, { cwd, stdout, dryRun, echo = true, trim = true, label }: ExecOptions & { trim?: boolean } = {}) {
    echo && stdout?.write(Chalk.gray(`${label ? label + ' ' : ''}${Chalk.cyan(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

    // if (dryRun)
    //     return '';

    return new Promise<string>((resolve, reject) => {
        ChildProcess.exec(cmd, { cwd, env: _.omit(process.env, 'NODE_OPTIONS', 'INIT_CWD', 'PROJECT_CWD', 'PWD', 'npm_package_name', 'npm_package_version')  }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`Command "${cmd}" [${cwd}] failed [${err}]`));
                return;
            }

            resolve(trim ? stdout.trim() : stdout);
        });
    }).catch(err => {
        throw new Error(`Shell exec failed: ${err}`);
    });
}
