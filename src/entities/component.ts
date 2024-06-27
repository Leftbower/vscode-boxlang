//import findup from "findup-sync";
import * as fs from "fs";
import * as path from "path";
import { Position, Range, TextDocument, Uri, workspace } from "vscode";
import * as cachedEntities from "../features/cachedEntities";
import { getComponent, hasComponent } from "../features/cachedEntities";
import { MySet } from "../utils/collections";
import { isCfcFile } from "../utils/contextUtil";
import { DocumentPositionStateContext, DocumentStateContext } from "../utils/documentUtil";
import { resolveCustomMappingPaths, resolveRelativePath, resolveRootPath } from "../utils/fileUtil";
import { Attribute, Attributes, parseAttributes } from "./attribute";
import { DataType } from "./dataType";
import { DocBlockKeyValue, parseDocBlock } from "./docblock";
import { constructGetter, constructSetter, parseProperties, Properties, Property } from "./property";
import { ComponentFunctions, parseScriptFunctions, parseTagFunctions, UserFunction } from "./userFunction";
import { parseVariableAssignments, Variable } from "./variable";

export const COMPONENT_EXT: string = ".cfc";
export const COMPONENT_FILE_GLOB: string = "**/*" + COMPONENT_EXT;

export const COMPONENT_TAG_PATTERN: RegExp = /((<cf)(component|interface)\b)([^>]*)/i;
export const COMPONENT_SCRIPT_PATTERN: RegExp = /((\/\*\*((?:\*(?!\/)|[^*])*)\*\/\s+)?(component|interface)\b)([^{]*)/i;

export const componentExtendsPathPrefix: RegExp = /\b(extends|implements)\s*=\s*(['"])?([^'"#\s]*?)$/i;

export const componentDottedPathPrefix: RegExp = /\b(import|new)\s+(?:component\s*:\s*)?(['"])?([^('":;\n]*?)$/i;

export const objectNewInstanceInitPrefix: RegExp = /\bnew\s+(?:component\s*:\s*)?(['"])?([^('":]+?)\1\($/i;

export interface ReferencePattern {
  pattern: RegExp;
  refIndex: number;
}

export const objectReferencePatterns: ReferencePattern[] = [
  // new object
  {
    pattern: /\bnew\s+(?:component\s*:\s*)?(['"])?([^('":]+?)\1\(/gi,
    refIndex: 2
  },
  // import
  {
    pattern: /\bimport\s+(['"])?([^'"]+?)\1(?:;|\n)/gi,
    refIndex: 2
  },
  // createObject
  {
    pattern: /\bcreateObject\s*\(\s*(['"])component\1\s*,\s*(['"])([^'"]+?)\2/gi,
    refIndex: 3
  },
  // cfobject or cfinvoke
  {
    pattern: /\bcomponent\s*(?:=|:)\s*(['"])([^'"]+?)\1/gi,
    refIndex: 2
  },
  // isInstanceOf
  {
    pattern: /\bisInstanceOf\s*\(\s*[\w$.]+\s*,\s*(['"])([^'"]+?)\1/gi,
    refIndex: 2
  },
];
// TODO: variableReferencePatterns

const cfmlOutlineSettings = workspace.getConfiguration("cfml.outline");
const showImplicitFunctions = cfmlOutlineSettings.get<boolean>("showImplicitFunctions", true);

const componentAttributeNames: MySet<string> = new MySet([
  "accessors",
  "alias",
  "autoindex",
  "bindingname",
  "consumes",
  "displayname",
  "extends",
  "hint",
  "httpmethod",
  "implements",
  "indexable",
  "indexlanguage",
  "initmethod",
  "mappedsuperclass",
  "namespace",
  "output",
  "persistent",
  "porttypename",
  "produces",
  "rest",
  "restPath",
  "serializable",
  "serviceaddress",
  "serviceportname",
  "style",
  "wsdlfile",
  "wsVersion"
]);
const booleanAttributes: MySet<string> = new MySet([
  "accessors",
  "autoindex",
  "indexable",
  "mappedsuperclass",
  "output",
  "persistent",
  "rest",
  "serializable"
]);

export interface Component {
  uri: Uri;
  name: string;
  isScript: boolean;
  isInterface: boolean; // should be a separate type, but chose this for the purpose of simplification
  declarationRange: Range;
  displayname: string;
  hint: string;
  accessors: boolean;
  initmethod?: string;
  // TODO: Investigate matching implements since interfaces can extend multiple interfaces
  extends?: Uri;
  extendsRange?: Range;
  implements?: Uri[];
  implementsRanges?: Range[];
  functions: ComponentFunctions;
  properties: Properties;
  variables: Variable[];
  imports: string[];
}

interface ComponentAttributes {
  accessors?: boolean;
  alias?: string;
  autoindex?: boolean;
  bindingname?: string;
  consumes?: string;
  displayname?: string;
  extends?: string;
  hint?: string;
  httpmethod?: string;
  implements?: string;
  indexable?: boolean;
  indexlanguage?: string;
  initmethod?: string;
  mappedsuperclass?: boolean;
  namespace?: string;
  output?: boolean;
  persistent?: boolean;
  porttypename?: string;
  produces?: string;
  rest?: boolean;
  restPath?: string;
  serializable?: boolean;
  serviceaddress?: string;
  serviceportname?: string;
  style?: string;
  wsdlfile?: string;
  wsVersion?: string;
}
export interface ComponentsByUri {
  [uri: string]: Component; // key is Uri.toString()
}
export interface ComponentsByName {
  [name: string]: ComponentsByUri; // key is Component name lowercased
}

/**
 * Determines whether the given document is a script-based component
 * @param document The document to check
 */
export function isScriptComponent(document: TextDocument): boolean {
  const componentTagMatch: RegExpExecArray = COMPONENT_TAG_PATTERN.exec(document.getText());
  if (componentTagMatch) {
    return false;
  }

  return isCfcFile(document);
}

/**
 * Parses a component document and returns an object conforming to the Component interface
 * @param documentStateContext The context information for a TextDocument to be parsed
 */
export function parseComponent(documentStateContext: DocumentStateContext): Component | undefined {
  const document: TextDocument = documentStateContext.document;
  const documentText: string = document.getText();
  const componentIsScript: boolean = documentStateContext.docIsScript;

  let componentMatch: RegExpExecArray;
  let head: string;
  let attributePrefix: string;
  let fullPrefix: string | undefined;
  let componentDoc: string | undefined;
  let checkTag: string | undefined;
  let componentType: string;
  let componentAttrs: string;

  if (!componentIsScript) {
    componentMatch = COMPONENT_TAG_PATTERN.exec(documentText);

    if (!componentMatch) {
      return undefined;
    }

    head = componentMatch[0];
    attributePrefix = componentMatch[1];
    checkTag = componentMatch[2];
    componentType = componentMatch[3];
    componentAttrs = componentMatch[4];
  } else {
    componentMatch = COMPONENT_SCRIPT_PATTERN.exec(documentText);

    if (!componentMatch) {
      return undefined;
    }

    head = componentMatch[0];
    attributePrefix = componentMatch[1];
    fullPrefix = componentMatch[2];
    componentDoc = componentMatch[3];
    componentType = componentMatch[4];
    componentAttrs = componentMatch[5];
  }

  let declarationStartOffset: number = componentMatch.index;
  if (fullPrefix) {
    declarationStartOffset += fullPrefix.length;
  }
  if (checkTag) {
    declarationStartOffset += checkTag.length;
  }

  let componentAttributes: ComponentAttributes = {};
  let component: Component = {
    uri: document.uri,
    name: path.basename(document.fileName, COMPONENT_EXT),
    isScript: componentIsScript,
    isInterface: componentType === "interface",
    declarationRange: new Range(document.positionAt(declarationStartOffset), document.positionAt(declarationStartOffset + componentType.length)),
    displayname: "",
    hint: "",
    extends: null,
    implements: null,
    accessors: false,
    functions: new ComponentFunctions(),
    properties: parseProperties(documentStateContext),
    variables: [],
    imports: []
  };

  if (componentDoc) {
    const parsedDocBlock: DocBlockKeyValue[] = parseDocBlock(
      document,
      new Range(
        document.positionAt(componentMatch.index + 3),
        document.positionAt(componentMatch.index + 3 + componentDoc.length)
      )
    );
    const docBlockAttributes: ComponentAttributes = processDocBlock(parsedDocBlock);
    Object.assign(componentAttributes, docBlockAttributes);

    parsedDocBlock.filter((docAttribute: DocBlockKeyValue) => {
      return docAttribute.key === "extends" && docAttribute.value;
    }).forEach((docAttribute: DocBlockKeyValue) => {
      component.extendsRange = new Range(
        docAttribute.valueRange.start,
        docAttribute.valueRange.end
      );
    });

    const implDocAttr = parsedDocBlock.find((docAttribute: DocBlockKeyValue) => {
      return docAttribute.key === "implements" && !!docAttribute.value;
    });
    if (implDocAttr) {
      component.implementsRanges = [];
      const implInitialOffset = document.offsetAt(implDocAttr.valueRange.start);
      let implOffset: number = 0;
      implDocAttr.value.split(",").forEach((element: string) => {
        const whitespaceMatch: RegExpExecArray = /\s+/.exec(element);
        const whitespaceLen = whitespaceMatch ? whitespaceMatch[0].length : 0;
        const interfacePathWordRange: Range = document.getWordRangeAtPosition(document.positionAt(implInitialOffset + implOffset + whitespaceLen), /[$\w.]+/);
        component.implementsRanges.push(interfacePathWordRange);

        implOffset += element.length + 1;
      });
    }
  }

  if (componentAttrs) {
    const componentAttributePrefixOffset: number = componentMatch.index + attributePrefix.length;
    const componentAttributeRange = new Range(
      document.positionAt(componentAttributePrefixOffset),
      document.positionAt(componentAttributePrefixOffset + componentAttrs.length)
    );

    const parsedAttributes: Attributes = parseAttributes(document, componentAttributeRange, componentAttributeNames);

    const tagAttributes: ComponentAttributes = processAttributes(parsedAttributes);
    Object.assign(componentAttributes, tagAttributes);

    if (parsedAttributes.has("extends")) {
      const extendsAttr: Attribute = parsedAttributes.get("extends");
      if (extendsAttr.value) {
        component.extendsRange = new Range(
          extendsAttr.valueRange.start,
          extendsAttr.valueRange.end
        );
      }
    }

    if (parsedAttributes.has("implements")) {
      const implementsAttr: Attribute = parsedAttributes.get("implements");
      if (implementsAttr.value) {
        component.implementsRanges = [];
        const implInitialOffset = document.offsetAt(implementsAttr.valueRange.start);
        let implOffset: number = 0;
        implementsAttr.value.split(",").forEach((element: string) => {
          const whitespaceMatch: RegExpExecArray = /\s+/.exec(element);
          const whitespaceLen = whitespaceMatch ? whitespaceMatch[0].length : 0;
          const interfacePathWordRange: Range = document.getWordRangeAtPosition(document.positionAt(implInitialOffset + implOffset + whitespaceLen), /[$\w.]+/);
          component.implementsRanges.push(interfacePathWordRange);

          implOffset += element.length + 1;
        });
      }
    }
  }

  Object.getOwnPropertyNames(component).forEach((propName: string) => {
    // TODO: Is this just supposed to be checking for existence or also value? Because it is ignoring falsy property values too
    if (componentAttributes[propName]) {
      if (propName === "extends") {
        component.extends = componentPathToUri(componentAttributes.extends, document.uri);
      } else if (propName === "implements") {
        componentAttributes.implements.split(",").forEach((element: string) => {
          const implementsUri: Uri = componentPathToUri(element.trim(), document.uri);
          if (implementsUri) {
            if (!component.implements) {
              component.implements = [];
            }
            component.implements.push(implementsUri);
          }
        });
      } else if (propName === "persistent" && componentAttributes.persistent) {
        component.accessors = true;
      } else {
        component[propName] = componentAttributes[propName];
      }
    }
  });

  documentStateContext.component = component;
  let componentFunctions = new ComponentFunctions();
  let userFunctions: UserFunction[] = parseScriptFunctions(documentStateContext);
  userFunctions = userFunctions.concat(parseTagFunctions(documentStateContext));
  let earliestFunctionRangeStart: Position = document.positionAt(documentText.length);
  userFunctions.forEach((compFun: UserFunction) => {
    if (compFun.location.range.start.isBefore(earliestFunctionRangeStart)) {
      earliestFunctionRangeStart = compFun.location.range.start;
    }
    componentFunctions.set(compFun.name.toLowerCase(), compFun);
  });

  // Implicit functions
  if (component.accessors) {
    component.properties.forEach((prop: Property) => {
      // getters
      if (typeof prop.getter === "undefined" || prop.getter) {
        const getterKey = "get" + prop.name.toLowerCase();
        if (!componentFunctions.has(getterKey)) {
          componentFunctions.set(getterKey, constructGetter(prop, component.uri));
        }
      }
      // setters
      if (typeof prop.setter === "undefined" || prop.setter) {
        const setterKey = "set" + prop.name.toLowerCase();
        if (!componentFunctions.has(setterKey)) {
          componentFunctions.set(setterKey, constructSetter(prop, component.uri));
        }
      }
    });
  }

  component.functions = componentFunctions;

  // Only check before first function definition
  const componentDefinitionRange = new Range(document.positionAt(componentMatch.index + head.length), earliestFunctionRangeStart);
  component.variables = parseVariableAssignments(documentStateContext, componentIsScript, componentDefinitionRange);

  // TODO: Get imports

  return component;
}

/**
 * Parses a component document and returns an object conforming to the Component interface
 * @param documentPositionStateContext The context information for the TextDocument and position to be check
 */
export function isInComponentHead(documentPositionStateContext: DocumentPositionStateContext): boolean {
  const document: TextDocument = documentPositionStateContext.document;
  const documentText: string = documentPositionStateContext.sanitizedDocumentText;
  const componentPattern: RegExp = documentPositionStateContext.docIsScript ? COMPONENT_SCRIPT_PATTERN : COMPONENT_TAG_PATTERN;
  const componentMatch: RegExpExecArray = componentPattern.exec(documentText);

  if (!componentMatch) {
    return false;
  }

  const head: string = componentMatch[0];

  if (!head) {
    return false;
  }

  const componentHeadRange = new Range(new Position(0, 0), document.positionAt(componentMatch.index + head.length));

  return componentHeadRange.contains(documentPositionStateContext.position);
}

/**
 * Parses a documentation block for a component and returns an object conforming to the ComponentAttributes interface
 * @param docBlock The documentation block to be processed
 */
function processDocBlock(docBlock: DocBlockKeyValue[]): ComponentAttributes {
  let docBlockObj: ComponentAttributes = {};
  docBlock.forEach((docElem: DocBlockKeyValue) => {
    const activeKey = docElem.key;
    if (booleanAttributes.has(activeKey)) {
      docBlockObj[activeKey] = DataType.isTruthy(docElem.value);
    } else {
      docBlockObj[activeKey] = docElem.value;
    }
  });

  return docBlockObj;
}

/**
 * Processes a set of attributes for a component and returns an object conforming to the ComponentAttributes interface
 * @param attributes A set of attributes
 */
function processAttributes(attributes: Attributes): ComponentAttributes {
  let attributeObj: ComponentAttributes = {};

  attributes.forEach((attr: Attribute, attrKey: string) => {
    if (booleanAttributes.has(attrKey)) {
      attributeObj[attrKey] = DataType.isTruthy(attr.value);
    } else {
      attributeObj[attrKey] = attr.value;
    }
  });

  return attributeObj;
}

/**
 * Resolves a component in dot-path notation to a URI
 * @param dotPath A string for a component in dot-path notation
 * @param baseUri The URI from which the component path will be resolved
 */
export function componentPathToUri(dotPath: string, baseUri: Uri): Uri | undefined {
  if (!dotPath) {
    return undefined;
  }

  const cachedResult: Uri = cachedEntities.componentPathToUri(dotPath, baseUri);
  if (cachedResult) {
    return cachedResult;
  }

  const normalizedPath: string = dotPath.replace(/\./g, path.sep) + COMPONENT_EXT;

  /* Note
  If ColdFusion finds a directory that matches the first path element, but does not find a CFC under that directory, ColdFusion returns a not found error and does NOT search for another directory.
  This implementation does not do this.
  */

  // relative to local directory
  const localPath: string = resolveRelativePath(baseUri, normalizedPath);
  if (fs.existsSync(localPath)) {
    return Uri.file(localPath);
  }

  // relative to web root
  const rootPath: string = resolveRootPath(baseUri, normalizedPath);
  if (rootPath && fs.existsSync(rootPath)) {
    return Uri.file(rootPath);
  }

  // custom mappings
  const customMappingPaths: string[] = resolveCustomMappingPaths(baseUri, normalizedPath);
  for (const mappedPath of customMappingPaths) {
    if (fs.existsSync(mappedPath)) {
      return Uri.file(mappedPath);
    }
  }

  return undefined;
}

/**
 * Returns just the name part for a component dot path
 * @param path Dot path to a component
 */
export function getComponentNameFromDotPath(path: string): string {
  return path.split(".").pop();
}

/**
 * Finds the applicable Application file for the given file URI
 * @param baseUri The URI from which the Application file will be searched
 */
export function getApplicationUri(baseUri: Uri): Uri | undefined {
  if (baseUri.scheme !== "file") {
    return undefined;
  }

  let componentUri: Uri;

//   if ( findup ) {
//     const fileNamesGlob = "Application.@(cfc|cfm)";
//     const currentWorkingDir: string = path.dirname(baseUri.fsPath);
//     console.log(baseUri.fsPath);
//     const applicationFile: string = findup(fileNamesGlob, { cwd: currentWorkingDir });
//     if (applicationFile) {
//         componentUri = Uri.file(applicationFile);
//     }
//   }
  return componentUri;
}

/**
 * Finds the applicable Server file for the given file URI
 * @param baseUri The URI from which the Server file will be searched
 */
export function getServerUri(baseUri: Uri): Uri | undefined {
  let componentUri: Uri;

  const fileName = "Server.cfc";
  const rootPath: string = resolveRootPath(baseUri, fileName);

  if (rootPath) {
    const rootUri: Uri = Uri.file(rootPath);

    if (hasComponent(rootUri)) {
      componentUri = rootUri;
    }
  }

  // TODO: custom mapping

  return componentUri;
}

/**
 * Checks whether `checkComponent` is a subcomponent or equal to `baseComponent`
 * @param checkComponent The candidate subcomponent
 * @param baseComponent The candidate base component
 */
export function isSubcomponentOrEqual(checkComponent: Component, baseComponent: Component): boolean {
  while (checkComponent) {
    if (checkComponent.uri.toString() === baseComponent.uri.toString()) {
      return true;
    }

    if (checkComponent.extends) {
      checkComponent = getComponent(checkComponent.extends);
    } else {
      checkComponent = undefined;
    }
  }

  return false;
}

/**
 * Checks whether `checkComponent` is a subcomponent of `baseComponent`
 * @param checkComponent The candidate subcomponent
 * @param baseComponent The candidate base component
 */
export function isSubcomponent(checkComponent: Component, baseComponent: Component): boolean {
  if (checkComponent.extends) {
    checkComponent = getComponent(checkComponent.extends);
  } else {
    return false;
  }

  while (checkComponent) {
    if (checkComponent.uri.toString() === baseComponent.uri.toString()) {
      return true;
    }

    if (checkComponent.extends) {
      checkComponent = getComponent(checkComponent.extends);
    } else {
      checkComponent = undefined;
    }
  }

  return false;
}