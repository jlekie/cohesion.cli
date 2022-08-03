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
    label?: string;
}

export async function exec(cmd: string, { cwd, stdout, dryRun, echo = true, label }: ExecOptions = {}) {
    echo && stdout?.write(Chalk.gray(`${Chalk.cyan.bold(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

    if (dryRun)
        return;

    const env = cmd.startsWith('yarn')
        ? _.omit(process.env, 'NODE_OPTIONS', 'INIT_CWD' , 'PROJECT_CWD', 'PWD', 'npm_package_name', 'npm_package_version', 'npm_config_user_agent', 'npm_execpath', 'npm_node_execpath', 'BERRY_BIN_FOLDER')
        : process.env;
    // const env = process.env;
    const proc = ChildProcess.spawn(cmd, { stdio: 'inherit', shell: true, cwd, env });

    return new Promise<void>((resolve, reject) => {
        // proc.stdout.on('data', d => stdout?.write(`${label ? Chalk.cyan('[' + label + ']') + ' ' : ''}${Chalk.gray(_.trimStart(d))}`));
        // proc.stderr.on('data', d => stdout?.write(`${label ? Chalk.cyan('[' + label + ']') + ' ' : ''}${Chalk.gray(_.trimStart(d))}`));

        // proc.stdout.on('data', d => stdout?.write(d));
        // proc.stderr.on('data', d => stdout?.write(d));

        proc.on('close', (code) => code !== 0 ? reject(new Error(`${cmd} <${Path.resolve(cwd ?? '.')}> Exited with code ${code}`)) : resolve());
        proc.on('error', (err) => reject(err));
    }).catch(err => {
        throw new Error(`Shell exec failed: ${err}`);
    });
}
export async function execCmd(cmd: string, { cwd, stdout, dryRun, echo = true, trim = true }: ExecOptions & { trim?: boolean } = {}) {
    echo && stdout?.write(Chalk.gray(`${Chalk.cyan(cmd)} [${Path.resolve(cwd ?? '.')}]\n`));

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