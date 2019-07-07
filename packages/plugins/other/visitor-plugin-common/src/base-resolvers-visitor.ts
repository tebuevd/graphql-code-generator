import { ParsedConfig, RawConfig, BaseVisitor } from './base-visitor';
import * as autoBind from 'auto-bind';
import { DEFAULT_SCALARS } from './scalars';
import { ScalarsMap, EnumValuesMap, ParsedEnumValuesMap } from './types';
import { DeclarationBlock, DeclarationBlockConfig, indent, getBaseTypeNode, buildScalars, getConfigValue, getBaseType, getRootTypeNames, stripMapperTypeInterpolation } from './utils';
import {
  NameNode,
  ListTypeNode,
  NamedTypeNode,
  FieldDefinitionNode,
  ObjectTypeDefinitionNode,
  GraphQLSchema,
  NonNullTypeNode,
  UnionTypeDefinitionNode,
  ScalarTypeDefinitionNode,
  InterfaceTypeDefinitionNode,
  isObjectType,
  isInterfaceType,
  isNonNullType,
  isListType,
  isUnionType,
  GraphQLNamedType,
  GraphQLInterfaceType,
  isEnumType,
} from 'graphql';
import { DirectiveDefinitionNode, GraphQLObjectType, InputValueDefinitionNode, GraphQLOutputType } from 'graphql';
import { OperationVariablesToObject } from './variables-to-object';
import { ParsedMapper, parseMapper, transformMappers } from './mappers';
import { parseEnumValues } from './enum-values';

export interface ParsedResolversConfig extends ParsedConfig {
  contextType: ParsedMapper;
  rootValueType: ParsedMapper;
  mappers: {
    [typeName: string]: ParsedMapper;
  };
  defaultMapper: ParsedMapper | null;
  avoidOptionals: boolean;
  addUnderscoreToArgsType: boolean;
  enumValues: ParsedEnumValuesMap;
}

export interface RawResolversConfig extends RawConfig {
  /**
   * @name addUnderscoreToArgsType
   * @type boolean
   * @description Adds `_` to generated `Args` types in order to avoid duplicate identifiers.
   *
   * @example With Custom Values
   * ```yml
   *   config:
   *     addUnderscoreToArgsType: true
   * ```
   *
   */
  addUnderscoreToArgsType?: boolean;
  /**
   * @name contextType
   * @type string
   * @description Use this configuration to set a custom type for your `context`, and it will
   * effect all the resolvers, without the need to override it using generics each time.
   * If you wish to use an external type and import it from another file, you can use `add` plugin
   * and add the required `import` statement, or you can use a `module#type` syntax.
   *
   * @example Custom Context Type
   * ```yml
   * plugins
   *   config:
   *     contextType: MyContext
   * ```
   * @example Custom Context Type
   * ```yml
   * plugins
   *   config:
   *     contextType: ./my-types#MyContext
   * ```
   */
  contextType?: string;
  /**
   * @name rootValueType
   * @type string
   * @description Use this configuration to set a custom type for the `rootValue`, and it will
   * effect resolvers of all root types (Query, Mutation and Subscription), without the need to override it using generics each time.
   * If you wish to use an external type and import it from another file, you can use `add` plugin
   * and add the required `import` statement, or you can use a `module#type` syntax.
   *
   * @example Custom RootValue Type
   * ```yml
   * plugins
   *   config:
   *     rootValueType: MyRootValue
   * ```
   * @example Custom RootValue Type
   * ```yml
   * plugins
   *   config:
   *     rootValueType: ./my-types#MyRootValue
   * ```
   */
  rootValueType?: string;
  /**
   * @name mappers
   * @type Object
   * @description Replaces a GraphQL type usage with a custom type, allowing you to return custom object from
   * your resolvers.
   * You can use a `module#type` syntax.
   *
   * @example Custom Context Type
   * ```yml
   * plugins
   *   config:
   *     mappers:
   *       User: ./my-models#UserDbObject
   * ```
   */
  mappers?: { [typeName: string]: string };
  /**
   * @name defaultMapper
   * @type string
   * @description Allow you to set the default mapper when it's not being override by `mappers` or generics.
   * You can specify a type name, or specify a string in `module#type` format.
   * The defualt value of mappers it the TypeScript type generated by `typescript` package.
   *
   * @example Replace with any
   * ```yml
   * plugins
   *   config:
   *     defaultMapper: any
   * ```
   *
   * @example Custom Base Object
   * ```yml
   * plugins
   *   config:
   *     defaultMapper: ./my-file#BaseObject
   * ```
   *
   * @example Wrap default types with Partial
   * You can also specify a custom wrapper for the original type, without overring the original generated types, use "{T}" to specify the identifier. (for flow, use `$Shape<{T}>`)
   * ```yml
   * plugins
   *   config:
   *     defaultMapper: Partial<{T}>
   * ```
   */
  defaultMapper?: string;
  /**
   * @name avoidOptionals
   * @type boolean
   * @description This will cause the generator to avoid using TypeScript optionals (`?`),
   * so all field resolvers must be implemented in order to avoid compilation errors.
   *
   * @default false
   *
   * @example
   * ```yml
   * generates:
   * path/to/file.ts:
   *  plugins:
   *    - typescript
   *    - typescript-resolvers
   *  config:
   *    avoidOptionals: true
   * ```
   */
  avoidOptionals?: boolean;
  /**
   * @name showUnusedMappers
   * @type boolean
   * @description Warns about unused mappers.
   * @default true
   *
   * @example
   * ```yml
   * generates:
   * path/to/file.ts:
   *  plugins:
   *    - typescript
   *    - typescript-resolvers
   *  config:
   *    showUnusedMappers: true
   * ```
   */
  showUnusedMappers?: boolean;
  /**
   * @name enumValues
   * @type EnumValuesMap
   * @description Overrides the default value of enum values declared in your GraphQL schema, supported
   * in this plugin because of the need for integeration with `typescript` package.
   * See documentation under `typescript` plugin for more information and examples.
   *
   */
  enumValues?: EnumValuesMap;
}

export type ResolverTypes = { [gqlType: string]: string };
export type ResolverParentTypes = { [gqlType: string]: string };

export class BaseResolversVisitor<TRawConfig extends RawResolversConfig = RawResolversConfig, TPluginConfig extends ParsedResolversConfig = ParsedResolversConfig> extends BaseVisitor<TRawConfig, TPluginConfig> {
  protected _parsedConfig: TPluginConfig;
  protected _declarationBlockConfig: DeclarationBlockConfig = {};
  protected _collectedResolvers: { [key: string]: string } = {};
  protected _collectedDirectiveResolvers: { [key: string]: string } = {};
  protected _variablesTransfomer: OperationVariablesToObject;
  protected _usedMappers: { [key: string]: boolean } = {};
  protected _resolversTypes: ResolverTypes = {};
  protected _resolversParentTypes: ResolverParentTypes = {};
  protected _rootTypeNames: string[] = [];

  constructor(rawConfig: TRawConfig, additionalConfig: TPluginConfig, private _schema: GraphQLSchema, defaultScalars: ScalarsMap = DEFAULT_SCALARS) {
    super(
      rawConfig,
      {
        enumValues: parseEnumValues(_schema, rawConfig.enumValues),
        addUnderscoreToArgsType: getConfigValue(rawConfig.addUnderscoreToArgsType, false),
        contextType: parseMapper(rawConfig.contextType || 'any', 'ContextType'),
        rootValueType: parseMapper(rawConfig.rootValueType || '{}', 'RootValueType'),
        avoidOptionals: getConfigValue(rawConfig.avoidOptionals, false),
        defaultMapper: rawConfig.defaultMapper ? parseMapper(rawConfig.defaultMapper || 'any', 'DefaultMapperType') : null,
        mappers: transformMappers(rawConfig.mappers || {}),
        ...(additionalConfig || {}),
      } as TPluginConfig,
      buildScalars(_schema, defaultScalars)
    );

    autoBind(this);
    this._rootTypeNames = getRootTypeNames(_schema);
    this._variablesTransfomer = new OperationVariablesToObject(this.scalars, this.convertName);
    this._resolversTypes = this.createResolversFields(type => this.applyResolverTypeWrapper(type), type => this.clearResolverTypeWrapper(type));
    this._resolversParentTypes = this.createResolversFields(type => type, type => type);
  }

  protected shouldMapType(type: GraphQLNamedType, checkedBefore: { [typeName: string]: boolean } = {}, duringCheck: string[] = []): boolean {
    if (checkedBefore[type.name] !== undefined) {
      return checkedBefore[type.name];
    }

    if (type.name.startsWith('__') || this.config.scalars[type.name]) {
      return false;
    }

    if (this.config.mappers[type.name]) {
      return true;
    }

    if (isObjectType(type) || isInterfaceType(type)) {
      const fields = type.getFields();

      return Object.keys(fields)
        .filter(fieldName => {
          const field = fields[fieldName];
          const fieldType = getBaseType(field.type);

          return !duringCheck.includes(fieldType.name);
        })
        .some(fieldName => {
          const field = fields[fieldName];
          const fieldType = getBaseType(field.type);

          if (checkedBefore[fieldType.name] !== undefined) {
            return checkedBefore[fieldType.name];
          }

          if (this.config.mappers[type.name]) {
            return true;
          }

          duringCheck.push(type.name);
          const innerResult = this.shouldMapType(fieldType, checkedBefore, duringCheck);

          return innerResult;
        });
    }

    return false;
  }

  // Kamil: this one is heeeeavvyyyy
  protected createResolversFields(applyWrapper: (str: string) => string, clearWrapper: (str: string) => string): ResolverTypes {
    const allSchemaTypes = this._schema.getTypeMap();
    const nestedMapping: { [typeName: string]: boolean } = {};

    Object.keys(allSchemaTypes).forEach(typeName => {
      const schemaType = allSchemaTypes[typeName];
      nestedMapping[typeName] = this.shouldMapType(schemaType, nestedMapping);
    });

    return Object.keys(allSchemaTypes).reduce(
      (prev: ResolverTypes, typeName: string) => {
        if (typeName.startsWith('__')) {
          return prev;
        }

        let shouldApplyOmit = false;
        const isRootType = this._rootTypeNames.includes(typeName);

        const isMapped = this.config.mappers[typeName];
        const isScalar = this.config.scalars[typeName];
        const hasDefaultMapper = !!(this.config.defaultMapper && this.config.defaultMapper.type);
        const schemaType = allSchemaTypes[typeName];

        if (isRootType) {
          prev[typeName] = applyWrapper(this.config.rootValueType.type);

          return prev;
        } else if (isEnumType(schemaType) && this.config.enumValues[typeName]) {
          prev[typeName] = this.config.enumValues[typeName].typeIdentifier;
        } else if (isMapped && this.config.mappers[typeName].type) {
          this.markMapperAsUsed(typeName);
          prev[typeName] = applyWrapper(this.config.mappers[typeName].type);
        } else if (hasDefaultMapper && !hasPlaceholder(this.config.defaultMapper.type)) {
          prev[typeName] = applyWrapper(this.config.defaultMapper.type);
        } else if (isScalar) {
          prev[typeName] = applyWrapper(this._getScalar(typeName));
        } else if (isUnionType(schemaType)) {
          prev[typeName] = schemaType
            .getTypes()
            .map(type => this.getTypeToUse(type.name))
            .join(' | ');
        } else {
          shouldApplyOmit = true;
          prev[typeName] = this.convertName(typeName);
        }

        if ((shouldApplyOmit && prev[typeName] !== 'any' && isObjectType(schemaType)) || (isInterfaceType(schemaType) && !isMapped)) {
          const fields = schemaType.getFields();
          const relevantFields: { addOptionalSign: boolean; fieldName: string; replaceWithType: string }[] = Object.keys(fields)
            .map(fieldName => {
              const field = fields[fieldName];
              const baseType = getBaseType(field.type);
              const isUnion = isUnionType(baseType);

              if (!this.config.mappers[baseType.name] && !isUnion && !nestedMapping[baseType.name]) {
                return null;
              }

              const addOptionalSign = !this.config.avoidOptionals && !isNonNullType(field.type);

              return {
                addOptionalSign,
                fieldName,
                replaceWithType: this.wrapTypeWithModifiers(this.getTypeToUse(baseType.name), field.type),
              };
            })
            .filter(a => a);

          if (relevantFields.length > 0) {
            // Puts ResolverTypeWrapper on top of an entire type
            prev[typeName] = applyWrapper(this.replaceFieldsInType(prev[typeName], relevantFields));
          } else {
            // We still want to use ResolverTypeWrapper, even if we don't touch any fields
            prev[typeName] = applyWrapper(prev[typeName]);
          }
        }

        if (isMapped && hasPlaceholder(prev[typeName])) {
          prev[typeName] = replacePlaceholder(prev[typeName], typeName);
        }

        if (!isMapped && hasDefaultMapper && hasPlaceholder(this.config.defaultMapper.type)) {
          // Make sure the inner type has no ResolverTypeWrapper
          const name = clearWrapper(isScalar ? this._getScalar(typeName) : prev[typeName]);
          const replaced = replacePlaceholder(this.config.defaultMapper.type, name);

          // Don't wrap Union with ResolverTypeWrapper, each inner type already has it
          if (isUnionType(schemaType)) {
            prev[typeName] = replaced;
          } else {
            prev[typeName] = applyWrapper(replacePlaceholder(this.config.defaultMapper.type, name));
          }
        }

        return prev;
      },
      {} as ResolverTypes
    );
  }

  protected replaceFieldsInType(typeName: string, relevantFields: { addOptionalSign: boolean; fieldName: string; replaceWithType: string }[]): string {
    return `Omit<${typeName}, ${relevantFields.map(f => `'${f.fieldName}'`).join(' | ')}> & { ${relevantFields.map(f => `${f.fieldName}${f.addOptionalSign ? '?' : ''}: ${f.replaceWithType}`).join(', ')} }`;
  }

  protected applyMaybe(str: string): string {
    return `Maybe<${str}>`;
  }

  protected applyResolverTypeWrapper(str: string): string {
    return `ResolverTypeWrapper<${this.clearResolverTypeWrapper(str)}>`;
  }

  protected clearMaybe(str: string): string {
    if (str.startsWith('Maybe<')) {
      return str.replace(/Maybe<(.*?)>$/, '$1');
    }

    return str;
  }

  protected clearResolverTypeWrapper(str: string): string {
    if (str.startsWith('ResolverTypeWrapper<')) {
      return str.replace(/ResolverTypeWrapper<(.*?)>$/, '$1');
    }

    return str;
  }

  protected wrapTypeWithModifiers(baseType: string, type: GraphQLOutputType): string {
    if (isNonNullType(type)) {
      return this.clearMaybe(this.wrapTypeWithModifiers(baseType, type.ofType));
    } else if (isListType(type)) {
      const innerType = this.wrapTypeWithModifiers(baseType, type.ofType);

      return this.applyMaybe(`Array<${innerType}>`);
    } else {
      // ResolverTypeWrapper here?
      return this.applyMaybe(baseType);
    }
  }

  public buildResolversTypes(): string {
    return new DeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('type')
      .withName(this.convertName('ResolversTypes'))
      .withComment('Mapping between all available schema types and the resolvers types')
      .withBlock(
        Object.keys(this._resolversTypes)
          .map(typeName => indent(`${typeName}: ${this._resolversTypes[typeName]},`))
          .join('\n')
      ).string;
  }

  public buildResolversParentTypes(): string {
    return new DeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('type')
      .withName(this.convertName('ResolversParentTypes'))
      .withComment('Mapping between all available schema types and the resolvers parents')
      .withBlock(
        Object.keys(this._resolversParentTypes)
          .map(typeName => indent(`${typeName}: ${this._resolversParentTypes[typeName]},`))
          .join('\n')
      ).string;
  }

  public get schema(): GraphQLSchema {
    return this._schema;
  }

  public get defaultMapperType(): string {
    return this.config.defaultMapper.type;
  }

  public get unusedMappers() {
    return Object.keys(this.config.mappers).filter(name => !this._usedMappers[name]);
  }

  public get mappersImports(): string[] {
    const groupedMappers: { [sourceFile: string]: { identifier: string; asDefault?: boolean }[] } = {};

    const addMapper = (source: string, identifier: string, asDefault: boolean) => {
      if (!groupedMappers[source]) {
        groupedMappers[source] = [];
      }

      if (!groupedMappers[source].find(m => m.identifier === identifier)) {
        groupedMappers[source].push({ identifier, asDefault });
      }
    };

    Object.keys(this.config.mappers)
      .filter(gqlTypeName => this.config.mappers[gqlTypeName].isExternal)
      .forEach(gqlTypeName => {
        const mapper = this.config.mappers[gqlTypeName];
        const identifier = stripMapperTypeInterpolation(mapper.type);
        addMapper(mapper.source, identifier, mapper.default);
      });

    if (this.config.contextType.isExternal) {
      addMapper(this.config.contextType.source, this.config.contextType.type, this.config.contextType.default);
    }

    if (this.config.rootValueType.isExternal) {
      addMapper(this.config.rootValueType.source, this.config.rootValueType.type, this.config.rootValueType.default);
    }

    if (this.config.defaultMapper && this.config.defaultMapper.isExternal) {
      const identifier = stripMapperTypeInterpolation(this.config.defaultMapper.type);
      addMapper(this.config.defaultMapper.source, identifier, this.config.defaultMapper.default);
    }

    return Object.keys(groupedMappers).map(source => this.buildMapperImport(source, groupedMappers[source]));
  }

  protected buildMapperImport(source: string, types: { identifier: string; asDefault?: boolean }[]): string {
    if (types[0] && types[0].asDefault) {
      return `import ${types[0].identifier} from '${source}';`;
    }

    return `import { ${types.map(t => t.identifier).join(', ')} } from '${source}';`;
  }

  setDeclarationBlockConfig(config: DeclarationBlockConfig): void {
    this._declarationBlockConfig = config;
  }

  setVariablesTransformer(variablesTransfomer: OperationVariablesToObject): void {
    this._variablesTransfomer = variablesTransfomer;
  }

  public getRootResolver(): string {
    const name = this.convertName('Resolvers');
    const contextType = `<ContextType = ${this.config.contextType.type}>`;

    // This is here because we don't want to break IResolvers, so there is a mapping by default,
    // and if the developer is overriding typesPrefix, it won't get generated at all.
    const deprecatedIResolvers = !this.config.typesPrefix
      ? `
/**
 * @deprecated
 * Use "Resolvers" root object instead. If you wish to get "IResolvers", add "typesPrefix: I" to your config.
*/
export type IResolvers${contextType} = ${name}<ContextType>;`
      : '';

    return [
      new DeclarationBlock(this._declarationBlockConfig)
        .export()
        .asKind('type')
        .withName(name, contextType)
        .withBlock(
          Object.keys(this._collectedResolvers)
            .map(schemaTypeName => {
              const resolverType = this._collectedResolvers[schemaTypeName];

              return indent(this.formatRootResolver(schemaTypeName, resolverType));
            })
            .join('\n')
        ).string,
      deprecatedIResolvers,
    ].join('\n');
  }

  protected formatRootResolver(schemaTypeName: string, resolverType: string): string {
    return `${schemaTypeName}${this.config.avoidOptionals ? '' : '?'}: ${resolverType},`;
  }

  public getAllDirectiveResolvers(): string {
    if (Object.keys(this._collectedDirectiveResolvers).length) {
      const name = this.convertName('DirectiveResolvers');
      const contextType = `<ContextType = ${this.config.contextType.type}>`;

      // This is here because we don't want to break IResolvers, so there is a mapping by default,
      // and if the developer is overriding typesPrefix, it won't get generated at all.
      const deprecatedIResolvers = !this.config.typesPrefix
        ? `
/**
* @deprecated
* Use "DirectiveResolvers" root object instead. If you wish to get "IDirectiveResolvers", add "typesPrefix: I" to your config.
*/
export type IDirectiveResolvers${contextType} = ${name}<ContextType>;`
        : '';

      return [
        new DeclarationBlock(this._declarationBlockConfig)
          .export()
          .asKind('type')
          .withName(name, contextType)
          .withBlock(
            Object.keys(this._collectedDirectiveResolvers)
              .map(schemaTypeName => {
                const resolverType = this._collectedDirectiveResolvers[schemaTypeName];

                return indent(this.formatRootResolver(schemaTypeName, resolverType));
              })
              .join('\n')
          ).string,
        deprecatedIResolvers,
      ].join('\n');
    }

    return '';
  }

  Name(node: NameNode): string {
    return node.value;
  }

  ListType(node: ListTypeNode): string {
    const asString = (node.type as any) as string;

    return `Array<${asString}>`;
  }

  protected _getScalar(name: string): string {
    return `Scalars['${name}']`;
  }

  NamedType(node: NamedTypeNode): string {
    const nameStr = (node.name as any) as string;

    if (this.config.scalars[nameStr]) {
      return this._getScalar(nameStr);
    }

    return this.convertName(node);
  }

  NonNullType(node: NonNullTypeNode): string {
    const asString = (node.type as any) as string;

    return asString;
  }

  protected markMapperAsUsed(name: string): void {
    this._usedMappers[name] = true;
  }

  protected getTypeToUse(name: string): string {
    const resolversType = this.convertName('ResolversTypes');

    return `${resolversType}['${name}']`;
  }

  protected getParentTypeToUse(name: string): string {
    const resolversType = this.convertName('ResolversParentTypes');

    return `${resolversType}['${name}']`;
  }

  FieldDefinition(node: FieldDefinitionNode, key: string | number, parent: any) {
    const hasArguments = node.arguments && node.arguments.length > 0;

    return (parentName: string) => {
      const original = parent[key];
      const baseType = getBaseTypeNode(original.type);
      const realType = baseType.name.value;
      const typeToUse = this.getTypeToUse(realType);
      const mappedType = this._variablesTransfomer.wrapAstTypeWithModifiers(typeToUse, original.type);
      const subscriptionType = this._schema.getSubscriptionType();
      const isSubscriptionType = subscriptionType && subscriptionType.name === parentName;

      return indent(
        `${node.name}${this.config.avoidOptionals ? '' : '?'}: ${isSubscriptionType ? 'SubscriptionResolver' : 'Resolver'}<${mappedType}, ParentType, ContextType${
          hasArguments
            ? `, ${this.convertName(parentName, {
                useTypesPrefix: true,
              }) +
                (this.config.addUnderscoreToArgsType ? '_' : '') +
                this.convertName(node.name, {
                  useTypesPrefix: false,
                }) +
                'Args'}`
            : ''
        }>,`
      );
    };
  }

  ObjectTypeDefinition(node: ObjectTypeDefinitionNode) {
    const name = this.convertName(node, {
      suffix: 'Resolvers',
    });

    const parentType = this.getParentTypeToUse((node.name as any) as string);

    const block = new DeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('type')
      .withName(name, `<ContextType = ${this.config.contextType.type}, ParentType = ${parentType}>`)
      .withBlock(node.fields.map((f: any) => f(node.name)).join('\n'));

    this._collectedResolvers[node.name as any] = name + '<ContextType>';

    return block.string;
  }

  UnionTypeDefinition(node: UnionTypeDefinitionNode, key: string | number, parent: any): string {
    const name = this.convertName(node, {
      suffix: 'Resolvers',
    });
    const originalNode = parent[key] as UnionTypeDefinitionNode;
    const possibleTypes = originalNode.types
      .map(node => node.name.value)
      .map(f => `'${f}'`)
      .join(' | ');

    this._collectedResolvers[node.name as any] = name;
    const parentType = this.getParentTypeToUse((node.name as any) as string);

    return new DeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('type')
      .withName(name, `<ContextType = ${this.config.contextType.type}, ParentType = ${parentType}>`)
      .withBlock(indent(`__resolveType: TypeResolveFn<${possibleTypes}, ParentType, ContextType>`)).string;
  }

  ScalarTypeDefinition(node: ScalarTypeDefinitionNode): string {
    const nameAsString = (node.name as any) as string;
    const baseName = this.getTypeToUse(nameAsString);

    this._collectedResolvers[node.name as any] = 'GraphQLScalarType';

    return new DeclarationBlock({
      ...this._declarationBlockConfig,
      blockTransformer(block) {
        return block;
      },
    })
      .export()
      .asKind('interface')
      .withName(
        this.convertName(node, {
          suffix: 'ScalarConfig',
        }),
        ` extends GraphQLScalarTypeConfig<${baseName}, any>`
      )
      .withBlock(indent(`name: '${node.name}'`)).string;
  }

  DirectiveDefinition(node: DirectiveDefinitionNode): string {
    const directiveName = this.convertName(node, {
      suffix: 'DirectiveResolver',
    });
    const hasArguments = node.arguments && node.arguments.length > 0;
    const directiveArgs = hasArguments ? this._variablesTransfomer.transform<InputValueDefinitionNode>(node.arguments) : '';

    this._collectedDirectiveResolvers[node.name as any] = directiveName + '<any, any, ContextType>';

    return new DeclarationBlock({
      ...this._declarationBlockConfig,
      blockTransformer(block) {
        return block;
      },
    })
      .export()
      .asKind('type')
      .withName(directiveName, `<Result, Parent, ContextType = ${this.config.contextType.type}, Args = { ${directiveArgs} }>`)
      .withContent(`DirectiveResolverFn<Result, Parent, ContextType, Args>`).string;
  }

  InterfaceTypeDefinition(node: InterfaceTypeDefinitionNode): string {
    const name = this.convertName(node, {
      suffix: 'Resolvers',
    });
    const allTypesMap = this._schema.getTypeMap();
    const implementingTypes: string[] = [];

    this._collectedResolvers[node.name as any] = name;

    for (const graphqlType of Object.values(allTypesMap)) {
      if (graphqlType instanceof GraphQLObjectType) {
        const allInterfaces = graphqlType.getInterfaces();
        if (allInterfaces.find(int => int.name === ((node.name as any) as string))) {
          implementingTypes.push(graphqlType.name);
        }
      }
    }

    const parentType = this.getParentTypeToUse((node.name as any) as string);

    const possibleTypes = implementingTypes.map(name => `'${name}'`).join(' | ') || 'null';

    return new DeclarationBlock(this._declarationBlockConfig)
      .export()
      .asKind('type')
      .withName(name, `<ContextType = ${this.config.contextType.type}, ParentType = ${parentType}>`)
      .withBlock([indent(`__resolveType: TypeResolveFn<${possibleTypes}, ParentType, ContextType>,`), ...(node.fields || []).map((f: any) => f(node.name))].join('\n')).string;
  }

  SchemaDefinition() {
    return null;
  }
}

function replacePlaceholder(pattern: string, typename: string): string {
  return pattern.replace('{T}', typename);
}

function hasPlaceholder(pattern: string): boolean {
  return pattern.includes('{T}');
}
