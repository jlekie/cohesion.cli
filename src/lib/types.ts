import { Static, Type, TSchema } from '@sinclair/typebox';
import { TypeCompiler, ValueError } from '@sinclair/typebox/compiler';
import { TypeSystem } from '@sinclair/typebox/system';



// import Ajv, { JSONSchemaType } from 'ajv';
// import addFormats from 'ajv-formats';

// const ajv = addFormats(new Ajv(), [
//     'date-time',
//     'time',
//     'date',
//     'email',
//     'hostname',
//     'ipv4',
//     'ipv6',
//     'uri',
//     'uri-reference',
//     'uuid',
//     'uri-template',
//     'json-pointer',
//     'relative-json-pointer',
//     'regex'
// ]);

export interface TypeDef<T extends TSchema> {
    schema: () => T;
    Schema: () => T;
    StaticType: Static<T>;
}
export interface CompiledTypeDef<T extends TSchema> extends TypeDef<T> {
    check: (value: unknown) => value is Static<T>;
    errors: (value: unknown) => IterableIterator<ValueError>;
    code: () => string;
}
export interface ParsedTypeDef<T extends TSchema, TOutput = T> extends TypeDef<T> {
    parse: (value: Static<T>) => TOutput;
}
export interface CompiledParsedTypeDef<T extends TSchema, TOutput = T> extends CompiledTypeDef<T>, ParsedTypeDef<T, TOutput> {
    checkAndParse: (value: unknown) => TOutput;
}

function simpleTypeDef<T extends TSchema>(schema: T): TypeDef<T> {
    return {
        schema: () => schema,
        Schema: () => schema,
        StaticType: schema as Static<T>
    }
}
function compiledTypeDef<T extends TSchema>(schema: T): CompiledTypeDef<T> {
    const SchemaDef = simpleTypeDef(schema);
    const compiled = TypeCompiler.Compile(schema);

    return {
        ...SchemaDef,
        check: (value: unknown): value is Static<T> => compiled.Check(value),
        errors: (value: unknown) => compiled.Errors(value),
        code: () => compiled.Code()
    }
}
function parsedTypeDef<T extends TSchema, TOutput = T>(schema: T, transform: (value: Static<T>, selfSchema: T) => TOutput): ParsedTypeDef<T, TOutput> {
    const SchemaDef = simpleTypeDef(schema);

    return {
        ...SchemaDef,
        parse: (value: Static<T>) => transform(value, schema)
    }
}
function compiledParsedTypeDef<T extends TSchema, TOutput = T>(schema: T, transform: (value: Static<T>, selfSchema: T) => TOutput): CompiledParsedTypeDef<T, TOutput> {
    const SchemaDef = compiledTypeDef(schema);

    return {
        ...SchemaDef,
        parse: (value: Static<T>) => transform(value, schema),
        checkAndParse: (value: unknown) => {
            if (!SchemaDef.check(value))
                throw new Error('schema validation failure', { cause: SchemaDef.errors(value) });

            return transform(value, schema);
        }
    }
}

export function typeDef<T extends TSchema>(type: 'simple', schema: T): TypeDef<T>;
export function typeDef<T extends TSchema>(type: 'compiled', schema: T): CompiledTypeDef<T>;
export function typeDef<T extends TSchema, TOutput = T>(type: 'parsed', schema: T, transform: (value: Static<T>, selfSchema: T) => TOutput): ParsedTypeDef<T, TOutput>;
export function typeDef<T extends TSchema, TOutput = T>(type: 'compiledParsed', schema: T, transform: (value: Static<T>, selfSchema: T) => TOutput): CompiledParsedTypeDef<T, TOutput>;
export function typeDef<T extends TSchema, TOutput = T>(type: 'simple' | 'compiled' | 'parsed' | 'compiledParsed', schema: T, transform?: (value: Static<T>, selfSchema: T) => TOutput) {
    if (type === 'simple')
        return simpleTypeDef(schema);
    else if (type === 'compiled')
        return compiledTypeDef(schema);
    else if (type === 'parsed' && transform)
        return parsedTypeDef(schema, transform);
    else if (type === 'compiledParsed' && transform)
        return compiledParsedTypeDef(schema, transform);
    else
        throw new Error('typeDef failure');
}

export type Constructor<T> = new (...args: any[]) => T;
export const InstanceOf = <T>(kind: string, Type: Constructor<T>, options?: Partial<{}> | undefined) => TypeSystem.CreateType<T, {}>(
    kind,
    (options, value) => value instanceof Type
)(options);
