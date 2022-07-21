#!/usr/bin/env node
import 'source-map-support/register';

import { Builtins, Cli, Command, Option } from 'clipanion';
import { loadConfig } from './lib/config';

const [ node, app, ...args ] = process.argv;

class ViewCommand extends Command {
    static paths = [['view']]

    cwd = Option.String('--cwd');
    config = Option.String('--config,-c', 'cohesion.yml');

    public async execute() {
        if (this.cwd)
            process.chdir(this.cwd);

        const config = await loadConfig(this.config);

        console.log(config);
        for await (const subConfig of config.resolveConfigs())
            console.log(subConfig.path, subConfig.labels)
    }
}

class DefaultCommand extends Command {
    static paths = [Command.Default]

    cwd = Option.String('--cwd');
    config = Option.String('--config,-c', 'cohesion.yml');

    args = Option.Rest();

    public async execute() {
        if (this.cwd)
            process.chdir(this.cwd);

        const config = await loadConfig(this.config);
        // console.log(config)

        // for await (const childConfig of config.resolveConfigs())
        //     console.log(childConfig);

        await config.exec(this.args);
    }
}

const cli = new Cli({
    binaryName: '[ cohesion ]',
    binaryLabel: 'Cohesion',
    binaryVersion: '1.0.0-alpha.1'
});

cli.register(ViewCommand);
cli.register(DefaultCommand);

cli.register(Builtins.HelpCommand);
cli.register(Builtins.VersionCommand);

cli.runExit(args).catch(err => {
    throw new Error(`Application failed to launch; ${err}`);
});
