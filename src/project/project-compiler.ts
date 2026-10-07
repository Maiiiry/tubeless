import { definePipeline, requireOutputs, type Pipeline } from "../core/pipeline.js";
import { didYouMean } from "../utilities/suggest.js";
import { ProjectRegistryResolver, type ProjectRegistry } from "./project-registry.js";
import { compileDocumentSteps } from "./project-step-graph.js";
import {
  validatePipelineDocument,
  PipelineDocumentError,
  type PipelineDocumentMetadata,
} from "./project-document.js";

export { PipelineDocumentError };
export type { ProjectRegistry } from "./project-registry.js";

/** Immutable compiled pipelines and descriptive metadata from a parsed document. */
export interface CompiledPipelineDocument {
  readonly pipelines: readonly Pipeline<object, unknown>[];
  readonly metadata?: PipelineDocumentMetadata;
  /** Return the shared compiled instance, or throw if the document has no such id. */
  get(id: string): Pipeline<object, unknown>;
}

/**
 * Compile parsed YAML or JSON into ordinary pipelines. Does not load modules,
 * invoke handlers or schemas, or perform I/O. Graph validation belongs to core.
 */
export function compilePipelineDocument(
  document: unknown,
  registry: ProjectRegistry
): CompiledPipelineDocument {
  const parsed = validatePipelineDocument(document);
  const resolvedRegistry = new ProjectRegistryResolver(registry);
  const compiled = new Map<string, Pipeline<object, unknown>>();
  const compiling = new Set<string>();

  const resolvePipeline = (id: string, path: string): Pipeline<object, unknown> => {
    if (!Object.hasOwn(parsed.pipelines, id)) {
      throw new PipelineDocumentError(path, `Unknown pipeline ${JSON.stringify(id)}`);
    }
    if (compiling.has(id)) {
      throw new PipelineDocumentError(
        path,
        `Pipeline composition cycle through ${JSON.stringify(id)}`
      );
    }
    return compile(id);
  };

  const compile = (id: string): Pipeline<object, unknown> => {
    const existing = compiled.get(id);
    if (existing) return existing;
    const definition = parsed.pipelines[id]!;
    const path = `$.pipelines[${JSON.stringify(id)}]`;
    compiling.add(id);
    const optionsSchema = resolvedRegistry.optionsSchema(
      definition.optionsSchema,
      `${path}.optionsSchema`
    );
    const graph = compileDocumentSteps(
      definition.steps,
      optionsSchema,
      resolvedRegistry,
      resolvePipeline,
      path
    );
    const finalize = resolvedRegistry.finalizer(definition.finalize.run, `${path}.finalize.run`);
    const pipeline = definePipeline({
      id,
      name: definition.name,
      description: definition.description,
      steps: graph.steps,
      targets: graph.resolve(definition.targets, `${path}.targets`),
      resultSchema: resolvedRegistry.outputSchema(definition.resultSchema, `${path}.resultSchema`),
      finalize:
        definition.finalize.requireOutputs === undefined
          ? finalize
          : requireOutputs(
              graph.resolve(definition.finalize.requireOutputs, `${path}.finalize.requireOutputs`),
              finalize
            ),
    });
    compiled.set(id, pipeline);
    compiling.delete(id);
    return pipeline;
  };

  const pipelines = Object.freeze(Object.keys(parsed.pipelines).map(compile));
  const metadata =
    parsed.metadata === undefined
      ? undefined
      : Object.freeze({
          ...parsed.metadata,
          authors:
            parsed.metadata.authors === undefined
              ? undefined
              : Object.freeze([...parsed.metadata.authors]),
        });
  return Object.freeze({
    pipelines,
    ...(metadata === undefined ? {} : { metadata }),
    get(id: string): Pipeline<object, unknown> {
      const pipeline = compiled.get(id);
      if (pipeline) return pipeline;
      const suggestion = didYouMean(id, compiled.keys());
      throw new Error(
        `Compiled document does not define pipeline ${JSON.stringify(id)}.${suggestion ? ` ${suggestion}` : ""}`
      );
    },
  });
}
