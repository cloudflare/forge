import {
  bool,
  defineStruct,
  defineUnion,
  f64,
  optStr,
  ref,
  sentinel,
  slice,
  str,
  u32,
  u64,
} from 'capnstruct';

export const NO_U32 = 0xffffffff;
export const NO_U64 = 0xffffffffffffffffn;
export const Availability = defineUnion('Availability', {
  None: null,
  Alpha: null,
  Beta: null,
  Preview: null,
  GenerallyAvailable: null,
  Deprecated: null,
});

export const HttpMethod = defineUnion('HttpMethod', {
  Get: null,
  Put: null,
  Post: null,
  Delete: null,
  Options: null,
  Head: null,
  Patch: null,
  Trace: null,
  Query: null,
  Connect: null,
  Other: str,
});

export const Location = defineUnion('Location', {
  Path: null,
  Query: bool,
});

export const ContentInfo = defineStruct('ContentInfo', {
  mediaType: str,
  ty: u32,
  description: str,
});

export const BodyInfo = defineStruct('BodyInfo', {
  required: bool,
  description: str,
  contents: slice(ContentInfo),
  json: sentinel(u32, NO_U32),
});

export const ResponseInfo = defineStruct('ResponseInfo', {
  status: str,
  description: str,
  contents: slice(ContentInfo),
  json: sentinel(u32, NO_U32),
});

export const Extension = defineStruct('Extension', {
  key: str,
  value: str,
});

export const GroupInfo = defineStruct('GroupInfo', {
  name: slice(str),
  description: str,
  path: slice(u32),
  parent: sentinel(u32, NO_U32),
  children: slice(u32),
  methods: slice(u32),
  models: slice(u32),
});

export const MethodInfo = defineStruct('MethodInfo', {
  name: slice(str),
  group: u32,
  httpMethod: HttpMethod,
  path: str,
  summary: str,
  description: str,
  deprecated: bool,
  availability: Availability,
  hidden: bool,
  confirmation: optStr,
  request: sentinel(u32, NO_U32),
  paramsType: sentinel(u32, NO_U32),
  paramLocations: slice(Location),
  headers: sentinel(u32, NO_U32),
  body: ref(BodyInfo),
  responses: slice(ResponseInfo),
  errors: slice(ResponseInfo),
  extensions: slice(Extension),
});

export const ModelInfo = defineStruct('ModelInfo', {
  schemaName: str,
  name: slice(str),
  group: u32,
  description: str,
  deprecated: bool,
  ty: u32,
});

export const NumberKind = defineUnion('NumberKind', {
  Int: null,
  Int8: null,
  Int16: null,
  Int32: null,
  Int64: null,
  Uint8: null,
  Uint16: null,
  Uint32: null,
  Uint64: null,
  Float: null,
  Double: null,
});

export const Scalar = defineUnion('Scalar', {
  Unknown: null,
  Null: null,
  Boolean: null,
  String: null,
  Number: NumberKind,
  DateTime: null,
  Date: null,
  Bytes: null,
  Binary: null,
  Uuid: null,
});

export const EnumValue = defineUnion('EnumValue', {
  String: str,
  Number: f64,
  Boolean: bool,
});

export const FieldInfo = defineStruct('FieldInfo', {
  wireName: str,
  name: slice(str),
  description: str,
  default: optStr,
  ty: u32,
  required: bool,
  deprecated: bool,
  readOnly: bool,
  sensitive: bool,
});

export const ArrayInfo = defineStruct('ArrayInfo', {
  elem: u32,
  minItems: sentinel(u64, NO_U64),
  maxItems: sentinel(u64, NO_U64),
});

export const ObjectInfo = defineStruct('ObjectInfo', {
  fields: slice(FieldInfo),
  extra: sentinel(u32, NO_U32),
});

export const DiscriminatorCase = defineStruct('DiscriminatorCase', {
  value: str,
  ty: u32,
});

export const DiscriminatorInfo = defineStruct('DiscriminatorInfo', {
  wireName: str,
  name: slice(str),
  cases: slice(DiscriminatorCase),
  defaultModel: sentinel(u32, NO_U32),
});


export const UnionInfo = defineStruct('UnionInfo', {
  members: slice(u32),
  exclusive: bool,
  discriminator: ref(DiscriminatorInfo),
});

export const TypeInfo = defineUnion('TypeInfo', {
  Scalar,
  Enum: slice(EnumValue),
  Array: ArrayInfo,
  Object: ObjectInfo,
  Union: UnionInfo,
  Intersection: slice(u32),
  Model: u32,
});

export const ForgeDoc = defineStruct('ForgeDoc', {
  version: str,
  description: str,
  baseUrl: str,
  groupOrder: slice(u32),
  groups: slice(GroupInfo),
  methods: slice(MethodInfo),
  models: slice(ModelInfo),
  types: slice(TypeInfo),
});

export const FORGE_SCHEMAS = [
  Availability,
  HttpMethod,
  Location,
  ContentInfo,
  BodyInfo,
  ResponseInfo,
  Extension,
  GroupInfo,
  MethodInfo,
  ModelInfo,
  NumberKind,
  Scalar,
  EnumValue,
  FieldInfo,
  ArrayInfo,
  ObjectInfo,
  DiscriminatorCase,
  DiscriminatorInfo,
  UnionInfo,
  TypeInfo,
  ForgeDoc,
] as const;
