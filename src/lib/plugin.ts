import { Type } from '@sinclair/typebox';
import { typeDef, InstanceOf } from './types';

import * as Stream from 'stream';

import { Action } from './app';

// export const ActionType = InstanceOf('Action', Action);
// export const WritableStreamType = InstanceOf('WritableStream', Stream.Writable);

export const PluginTypeDef = typeDef('compiled', Type.Object({
    registerActions: Type.Function([
        Type.Record(Type.String(), Type.Unknown()),
        Type.Function([
            Type.String(),
            Type.Function([
                InstanceOf('Action', Action),
                // Type.Record(Type.String(), Type.Unknown()),
                Type.Object({
                    vars: Type.Record(Type.String(), Type.String()),
                    stdout: Type.Optional(InstanceOf('WritableStream', Stream.Writable)),
                    label: Type.Optional(Type.String())
                })
            ], Type.Union([
                Type.Void(),
                Type.Promise(Type.Void())
            ]))
        ], Type.Void())
    ], Type.Union([
        Type.Void(),
        Type.Promise(Type.Void())
    ]))
}))

export async function loadPlugin(uri: string): Promise<typeof PluginTypeDef.StaticType> {
    const importedModule = await import(uri);

    if (!PluginTypeDef.check(importedModule))
        throw new Error('plugin load failure', { cause: PluginTypeDef.errors(importedModule) });

    return importedModule;
}
