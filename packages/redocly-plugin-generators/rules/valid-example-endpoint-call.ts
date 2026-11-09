import { rootOf } from '../utils/document.ts';
import {
  buildEndpointModels,
  isUnknownSchema,
  type EndpointModel,
  type ErrorModel,
  type ParameterDeclaration,
  type ParameterKind,
  type ResponseModel,
} from '../utils/examples-endpoint.ts';
import {
  isCodeSamplesOnly,
  keptEntries,
  readFernExamples,
  type FernExampleEntry,
} from '../utils/examples-extension.ts';
import { multipartParts } from '../utils/examples-multipart.ts';
import type { RefOccurrence } from '../utils/naming-request-wrapper.ts';
import { describeValue, ExampleValidator, locationAt, pointerOf } from '../utils/examples.ts';
import { isPlainObject } from '../utils/resolve.ts';
import type { AnyNode, Located, Location, RuleDefinition, UserContext } from '../utils/types.ts';

/**
 * Checks each `x-fern-examples` entry against the endpoint Fern generates from the operation:
 * entries Fern drops because they do not match its example schema, missing or unexpected
 * headers, path and query parameters (accounting for auth headers Fern strips, global headers it
 * adds and path parameters it renames), parameter values, the request body, the response body,
 * error responses (Fern names errors after status codes) and streamed events. Values are
 * validated with Ajv against the OpenAPI schemas, with Fern's treatment of `readOnly` (accepted,
 * never required, dropped from inlined request bodies) and of multipart file parts (unexpected).
 */

const SECTIONS: { key: string; kind: ParameterKind }[] = [
  { key: 'headers', kind: 'header' },
  { key: 'path-parameters', kind: 'path parameter' },
  { key: 'query-parameters', kind: 'query parameter' },
];

const REQUIRED_BODY_MESSAGE =
  "This operation's requestBody is required, so its x-fern-examples entries must specify request. " +
  'Set requestBody.required to false to allow calling the operation without a body.';

function errorList(model: EndpointModel): string {
  const errors = [...model.errors.values()];
  if (errors.length === 0) {
    return 'this operation declares no error responses (status codes 400-599, 4XX or 5XX)';
  }
  return `this operation declares: ${errors.map((error) => `${error.name} (${error.statusCode})`).join(', ')}`;
}

export const validExampleEndpointCall: RuleDefinition = {
  name: 'valid-example-endpoint-call',
  vendor: 'fern',
  sourceRules: ['fern-definition/valid-example-endpoint-call', 'docs/valid-openapi-examples'],
  severity: 'error',
  description:
    "x-fern-examples entries must match Fern's example format and the operation's parameters, request body, responses and errors.",
  rule: () => {
    const validator = new ExampleValidator();
    const refs: RefOccurrence[] = [];
    return {
      ref: {
        enter(_node: AnyNode, ctx: UserContext, resolved: AnyNode) {
          if (resolved?.location !== undefined) {
            refs.push({
              from: ctx.location.absolutePointer,
              to: resolved.location.absolutePointer,
            });
          }
        },
      },
      Root: {
        leave(root: AnyNode, ctx: UserContext) {
          const models = buildEndpointModels(ctx, rootOf(root, ctx), refs);
          // The errors Fern declares for the whole API, by name.
          const apiErrors = new Map<string, ErrorModel>();
          for (const model of models) {
            for (const [name, error] of model.errors) {
              if (!apiErrors.has(name)) {
                apiErrors.set(name, error);
              }
            }
          }

          const validate = (
            data: unknown,
            schema: Located | { standalone: Record<string, unknown> },
            location: Location,
            part: string,
          ): void => {
            for (const error of validator.validate(ctx, data, schema)) {
              const at =
                error.path.length === 0 || (error.onKey && error.path.length === 1)
                  ? ''
                  : ` at "${pointerOf(error.onKey ? error.path.slice(0, -1) : error.path)}"`;
              ctx.report({
                message: `Invalid ${part} example${at}: ${error.message}`,
                location: locationAt(location, error.path, error.onKey),
              });
            }
          };

          const checkParameters = (model: EndpointModel, entry: FernExampleEntry): void => {
            for (const { key, kind } of SECTIONS) {
              const declarations = model.parameters[kind];
              const values: Record<string, AnyNode> | undefined = isPlainObject(entry.node[key])
                ? entry.node[key]
                : undefined;
              const sectionLocation = entry.location.child(key);
              for (const declaration of declarations) {
                if (!declaration.required) {
                  continue;
                }
                const keys = [declaration.key, ...declaration.alternateKeys];
                if (!keys.some((candidate) => values?.[candidate] !== undefined && values[candidate] !== null)) {
                  ctx.report({
                    message: `Example is missing required ${kind} "${declaration.key}"${declaration.origin === undefined ? '' : ` (${declaration.origin})`}`,
                    location: values === undefined ? entry.location : sectionLocation.key(),
                  });
                }
              }
              if (values === undefined) {
                continue;
              }
              for (const [name, value] of Object.entries(values)) {
                const declaration = declarations.find(
                  (candidate) => candidate.key === name || candidate.alternateKeys.includes(name),
                );
                if (declaration === undefined) {
                  const reason = model.dropped[kind].get(name);
                  ctx.report({
                    message: `Unexpected ${kind} "${name}"${reason === undefined ? '' : `; ${reason}`}`,
                    location: sectionLocation.child(name).key(),
                  });
                  continue;
                }
                checkParameterValue(declaration, value, sectionLocation.child(name), `${kind} "${name}"`);
              }
            }
          };

          const checkParameterValue = (
            declaration: ParameterDeclaration,
            value: unknown,
            location: Location,
            part: string,
          ): void => {
            if (value === undefined) {
              return;
            }
            // Fern accepts null for optional parameters; a required one reports both the missing
            // parameter and the null value.
            if (value === null && !declaration.required) {
              return;
            }
            if (declaration.literal !== undefined) {
              if (value === null) {
                return;
              }
              if (value !== declaration.literal && !(typeof value === 'string' && value.startsWith('$'))) {
                ctx.report({
                  message: `Invalid ${part} example: Expected example to be "${declaration.literal}". Example is: ${describeValue(value)} (Fern turns a header's string default into a constant)`,
                  location,
                });
              }
              return;
            }
            const schema =
              declaration.schema ??
              (declaration.standalone === undefined ? undefined : { standalone: declaration.standalone });
            if (schema === undefined) {
              return;
            }
            if (declaration.allowMultiple && Array.isArray(value)) {
              value.forEach((item, index) => {
                if (item !== null) {
                  validate(item, schema, location.child(index), part);
                }
              });
              return;
            }
            validate(value, schema, location, part);
          };

          const checkRequest = (model: EndpointModel, entry: FernExampleEntry): void => {
            const request = model.request;
            const value = entry.node.request;
            const location = entry.location.child('request');
            if (request.kind === 'none') {
              if (value !== undefined && value !== null) {
                ctx.report({
                  message:
                    'Unexpected request in example. The operation has no requestBody that Fern imports (JSON, form or multipart).',
                  location: location.key(),
                });
              }
              return;
            }
            if (request.kind === 'other') {
              return;
            }
            if (value === undefined) {
              if (request.kind === 'json' && request.required && !isUnknownSchema(ctx, request.schema)) {
                ctx.report({
                  message: REQUIRED_BODY_MESSAGE,
                  location: entry.location,
                });
              }
              return;
            }
            if (request.kind === 'multipart') {
              checkMultipart(request.schema, value, location);
              return;
            }
            if (isPlainObject(value)) {
              for (const key of Object.keys(value)) {
                if (model.droppedReadOnlyKeys.has(key)) {
                  ctx.report({
                    message: `Invalid request example: Unexpected property "${key}"; Fern drops readOnly properties from request bodies it inlines into the request`,
                    location: location.child(key).key(),
                  });
                }
              }
            }
            if (request.schema !== undefined) {
              validate(value, request.schema, location, 'request');
            }
          };

          const checkMultipart = (schema: Located | undefined, value: unknown, location: Location): void => {
            const parts = multipartParts(ctx, schema);
            if (parts === undefined || value === null) {
              return;
            }
            if (!isPlainObject(value)) {
              ctx.report({
                message: `Invalid request example: Expected example to be an object. Example is: ${describeValue(value)}`,
                location,
              });
              return;
            }
            for (const part of parts) {
              if (
                part.required &&
                !part.file &&
                !part.nullable &&
                !isUnknownSchema(ctx, part.schema) &&
                value[part.key] === undefined
              ) {
                ctx.report({
                  message: `Invalid request example: Example is missing required property "${part.key}"`,
                  location,
                });
              }
            }
            for (const [key, partValue] of Object.entries(value)) {
              const part = parts.find((candidate) => candidate.key === key);
              if (part === undefined || part.file) {
                ctx.report({
                  message:
                    part === undefined
                      ? `Invalid request example: Unexpected property "${key}"`
                      : `Invalid request example: Unexpected property "${key}"; Fern's example check does not accept file parts (format: binary) of multipart request bodies, so leave them out of examples`,
                  location: location.child(key).key(),
                });
                continue;
              }
              if (partValue !== null) {
                validate(partValue, part.schema, location.child(key), `request "${key}" part`);
              }
            }
          };

          const checkStreamCondition = (model: EndpointModel, entry: FernExampleEntry): void => {
            const declared = model.response;
            const request = entry.node.request;
            if (declared.kind !== 'condition' || !isPlainObject(request)) {
              return;
            }
            const value = request[declared.property];
            if (typeof value !== 'boolean') {
              return;
            }
            const response = entry.node.response;
            const streams = isPlainObject(response) && response.stream != null;
            const nonStreams = response != null && !streams;
            // Examples without a response apply to both endpoints.
            if ((value && !streams) || (!value && !nonStreams)) {
              const endpoint = value
                ? 'non-streaming endpoint (examples without response.stream)'
                : 'streaming endpoint (examples with response.stream or without a response)';
              ctx.report({
                message: `Invalid request example at "/${declared.property}": Expected example to be ${!value}. Example is: ${value} (the stream-condition property is the constant ${!value} on Fern's ${endpoint})`,
                location: entry.location.child(['request', declared.property]),
              });
            }
          };

          const checkErrorResponse = (
            model: EndpointModel,
            response: Record<string, AnyNode>,
            location: Location,
          ): void => {
            const name = response.error;
            const declared = model.errors.get(name);
            const error = declared ?? apiErrors.get(name);
            if (declared === undefined) {
              ctx.report({
                message: `"${name}" is not an error this operation declares. Fern names errors after their status codes (for example 404 becomes NotFoundError); ${errorList(model)}.`,
                location: location.child('error'),
              });
            }
            // Fern still checks the body of an error other operations declare.
            if (error === undefined || error.unknown) {
              return;
            }
            if (response.body === undefined) {
              ctx.report({
                message:
                  declared === undefined
                    ? `Example is missing response.body for ${error.name}; Fern declares ${error.name} with a body schema from the ${error.statusCode} response of another operation.`
                    : `Example is missing response.body for ${error.name}; the ${error.statusCode} response of this operation has a body schema.`,
                location,
              });
              return;
            }
            validate(response.body, error.schema!, location.child('body'), `${error.name} response`);
          };

          const checkResponse = (model: EndpointModel, entry: FernExampleEntry): void => {
            const declared = model.response;
            if (declared.kind === 'skip') {
              return;
            }
            const raw = entry.node.response;
            const response: Record<string, AnyNode> = isPlainObject(raw) ? raw : {};
            const location = entry.location.child('response');
            const isStream = Array.isArray(response.stream);
            const model_: ResponseModel =
              declared.kind !== 'condition'
                ? declared
                : isStream
                  ? {
                      kind: 'stream',
                      format: declared.format,
                      schema: declared.stream,
                    }
                  : {
                      kind: 'json',
                      schema: declared.response,
                      statusCode: '200',
                      optional: false,
                    };

            if (model_.kind === 'stream') {
              if (isStream) {
                const unknown = isUnknownSchema(ctx, model_.schema);
                (response.stream as AnyNode[]).forEach((item, index) => {
                  const itemLocation = location.child(['stream', index]);
                  if (model_.format === 'json') {
                    if (model_.schema !== undefined) {
                      validate(item, model_.schema, itemLocation, `stream event ${index}`);
                    }
                    return;
                  }
                  const data = isPlainObject(item) ? item.data : undefined;
                  if (data === undefined) {
                    if (!unknown) {
                      ctx.report({
                        message: `Server-sent event example ${index} is missing data. Write each event as {event, data}; data must match the event schema.`,
                        location: itemLocation,
                      });
                    }
                    return;
                  }
                  if (model_.schema !== undefined) {
                    validate(data, model_.schema, itemLocation.child('data'), `stream event ${index}`);
                  }
                });
                return;
              }
              if (typeof response.error === 'string') {
                checkErrorResponse(model, response, location);
                return;
              }
              if (response.body !== undefined && response.body !== null) {
                ctx.report({
                  message:
                    "Unexpected response in example. This operation streams its response, so list the streamed events under response.stream. If you're adding an example of an error response, set response.error to the error's name.",
                  location: location.child('body').key(),
                });
              }
              return;
            }

            if (typeof response.error === 'string') {
              checkErrorResponse(model, response, location);
              return;
            }
            const body = isStream ? undefined : response.body;
            if (model_.kind === 'json') {
              if (body === undefined) {
                if (model_.optional || isUnknownSchema(ctx, model_.schema)) {
                  return;
                }
                ctx.report({
                  message:
                    declared.kind === 'condition'
                      ? 'Example is missing response.body; Fern requires it because examples without response.stream also apply to the non-streaming endpoint it generates for this stream-condition operation, which returns the x-fern-streaming response schema.'
                      : isStream
                        ? `Unexpected streaming response in example. This operation does not stream (no x-fern-streaming and no text/event-stream response), so Fern reads the example as having no response body, but the ${model_.statusCode} response has a JSON body.`
                        : `Example is missing response.body; Fern requires it because the ${model_.statusCode} response of this operation has a JSON body.`,
                  location: isStream ? location.child('stream').key() : raw === undefined ? entry.location : location,
                });
                return;
              }
              if (body === null && model_.optional) {
                return;
              }
              if (model_.schema !== undefined) {
                validate(body, model_.schema, location.child('body'), 'response');
              }
              return;
            }
            if (model_.kind === 'none' && body !== undefined && body !== null) {
              ctx.report({
                message:
                  "Unexpected response in example. The operation has no success response with a body (200, 201, 202 or 204, or default when none of those exist). If you're adding an example of an error response, set response.error to the error's name (for example NotFoundError for 404).",
                location: location.child('body').key(),
              });
            }
          };

          for (const model of models) {
            const examples = readFernExamples(ctx, model.operation);
            if (examples === undefined) {
              continue;
            }
            if (examples.notAList) {
              ctx.report({
                message: 'x-fern-examples must be a list of example objects; Fern cannot read it.',
                location: examples.location,
              });
              continue;
            }
            for (const entry of examples.entries) {
              for (const problem of entry.problems) {
                ctx.report({
                  message: `Fern ignores x-fern-examples entry ${entry.index} because it does not match Fern's example format: ${problem.message}.`,
                  location: problem.location,
                });
              }
              for (const problem of entry.droppedCodeSamples) {
                ctx.report({
                  message: `${problem.message}.`,
                  location: problem.location,
                  forceSeverity: 'warn',
                });
              }
            }
            for (const entry of keptEntries(examples)) {
              if (isCodeSamplesOnly(entry)) {
                continue;
              }
              checkParameters(model, entry);
              checkRequest(model, entry);
              checkResponse(model, entry);
              checkStreamCondition(model, entry);
            }
          }
        },
      },
    };
  },
};
