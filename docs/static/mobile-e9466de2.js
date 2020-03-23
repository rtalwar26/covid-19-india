/*
GOAL: This module should mirror the NodeJS module system according the documented behavior.
The module transport will send down code that registers module definitions by an assigned path. In addition,
the module transport will send down code that registers additional metadata to allow the module resolver to
resolve modules in the browser. Additional metadata includes the following:

- "mains": The mapping of module directory paths to a fully resolved module path
- "remaps": The remapping of one fully resolved module path to another fully resolved module path (used for browser overrides)
- "run": A list of entry point modules that should be executed when ready

Inspired by:
https://github.com/joyent/node/blob/master/lib/module.js
*/
(function() {
    var win;

    if (typeof window !== 'undefined') {
        win = window;

        // This lasso modules client has already been loaded on the page. Do nothing;
        if (win.$_mod) {
            return;
        }

        win.global = win;
    }

    /** the module runtime */
    var $_mod;

    // this object stores the module factories with the keys being module paths and
    // values being a factory function or object (e.g. "/baz$3.0.0/lib/index" --> Function)
    var definitions = {};

    // Search path that will be checked when looking for modules
    var searchPaths = [];

    // The _ready flag is used to determine if "run" modules can
    // be executed or if they should be deferred until all dependencies
    // have been loaded
    var _ready = false;

    // If $_mod.run() is called when the page is not ready then
    // we queue up the run modules to be executed later
    var runQueue = [];

    // this object stores the Module instance cache with the keys being paths of modules (e.g., "/foo$1.0.0/bar" --> Module)
    var instanceCache = {};

    // This object maps installed dependencies to specific versions
    //
    // For example:
    // {
    //   // The package "foo" with version 1.0.0 has an installed package named "bar" (foo/node_modules/bar") and
    //   // the version of "bar" is 3.0.0
    //   "/foo$1.0.0/bar": "3.0.0"
    // }
    var installed = {};

    // Maps builtin modules such as "path", "buffer" to their fully resolved paths
    var builtins = {};

    // this object maps a directory to the fully resolved module path
    //
    // For example:
    //
    var mains = {};

    // used to remap a one fully resolved module path to another fully resolved module path
    var remapped = {};

    var cacheByDirname = {};

    // When a module is mapped to a global varialble we add a reference
    // that maps the path of the module to the loaded global instance.
    // We use this mapping to ensure that global modules are only loaded
    // once if they map to the same path.
    //
    // See issue #5 - Ensure modules mapped to globals only load once
    // https://github.com/raptorjs/raptor-modules/issues/5
    var loadedGlobalsByRealPath = {};

    function moduleNotFoundError(target, from) {
        var err = new Error('Cannot find module "' + target + '"' + (from ? ' from "' + from + '"' : ''));

        err.code = 'MODULE_NOT_FOUND';
        return err;
    }

    function Module(filename) {
       /*
        A Node module has these properties:
        - filename: The path of the module
        - id: The path of the module (same as filename)
        - exports: The exports provided during load
        - loaded: Has module been fully loaded (set to false until factory function returns)

        NOT SUPPORTED:
        - parent: parent Module
        - paths: The search path used by this module (NOTE: not documented in Node.js module system so we don't need support)
        - children: The modules that were required by this module
        */
        this.id = this.filename = filename;
        this.loaded = false;
        this.exports = undefined;
    }

    Module.cache = instanceCache;

    // temporary variable for referencing the Module prototype
    var Module_prototype = Module.prototype;

    Module_prototype.load = function(factoryOrObject) {
        var filename = this.id;

        if (factoryOrObject && factoryOrObject.constructor === Function) {
            // factoryOrObject is definitely a function
            var lastSlashPos = filename.lastIndexOf('/');

            // find the value for the __dirname parameter to factory
            var dirname = filename.substring(0, lastSlashPos);

            // local cache for requires initiated from this module/dirname
            var localCache = cacheByDirname[dirname] || (cacheByDirname[dirname] = {});

            // this is the require used by the module
            var instanceRequire = function(target) {
                // Only store the `module` in the local cache since `module.exports` may not be accurate
                // if there was a circular dependency
                var module = localCache[target] || (localCache[target] = requireModule(target, dirname));
                return module.exports;
            };

            // The require method should have a resolve method that will return the resolved
            // path but not actually instantiate the module.
            // This resolve function will make sure a definition exists for the corresponding
            // path of the target but it will not instantiate a new instance of the target.
            instanceRequire.resolve = function(target) {
                if (!target) {
                    throw moduleNotFoundError('');
                }

                var resolved = resolve(target, dirname);

                if (!resolved) {
                    throw moduleNotFoundError(target, dirname);
                }

                // NOTE: resolved[0] is the path and resolved[1] is the module factory
                return resolved[0];
            };

            // NodeJS provides access to the cache as a property of the "require" function
            instanceRequire.cache = instanceCache;

            // Expose the module system runtime via the `runtime` property
            // TODO: We should deprecate this in favor of `Module.prototype.__runtime`
            // @deprecated
            instanceRequire.runtime = $_mod;

            // $_mod.def("/foo$1.0.0/lib/index", function(require, exports, module, __filename, __dirname) {
            this.exports = {};

            // call the factory function
            factoryOrObject.call(this, instanceRequire, this.exports, this, filename, dirname);
        } else {
            // factoryOrObject is not a function so have exports reference factoryOrObject
            this.exports = factoryOrObject;
        }

        this.loaded = true;
    };

    /**
     * Defines a packages whose metadata is used by raptor-loader to load the package.
     */
    function define(path, factoryOrObject, options) {
        /*
        $_mod.def('/baz$3.0.0/lib/index', function(require, exports, module, __filename, __dirname) {
            // module source code goes here
        });
        */

        var globals = options && options.globals;

        definitions[path] = factoryOrObject;

        if (globals) {
            var target = win || global;
            for (var i=0;i<globals.length; i++) {
                var globalVarName = globals[i];
                var globalModule = loadedGlobalsByRealPath[path] = requireModule(path);
                target[globalVarName] = globalModule.exports;
            }
        }
    }

    function registerMain(path, relativePath) {
        mains[path] = relativePath;
    }

    function remap(fromPath, toPath) {
        remapped[fromPath] = toPath;
    }

    function builtin(name, target) {
        builtins[name] = target;
    }

    function registerInstalledDependency(parentPath, packageName, packageVersion) {
        // Example:
        // dependencies['/my-package$1.0.0/$/my-installed-package'] = '2.0.0'
        installed[parentPath + '/' + packageName] =  packageVersion;
    }

    /**
     * This function will take an array of path parts and normalize them by handling handle ".." and "."
     * and then joining the resultant string.
     *
     * @param {Array} parts an array of parts that presumedly was split on the "/" character.
     */
    function normalizePathParts(parts) {

        // IMPORTANT: It is assumed that parts[0] === "" because this method is used to
        // join an absolute path to a relative path
        var i;
        var len = 0;

        var numParts = parts.length;

        for (i = 0; i < numParts; i++) {
            var part = parts[i];

            if (part === '.') {
                // ignore parts with just "."
                /*
                // if the "." is at end of parts (e.g. ["a", "b", "."]) then trim it off
                if (i === numParts - 1) {
                    //len--;
                }
                */
            } else if (part === '..') {
                // overwrite the previous item by decrementing length
                len--;
            } else {
                // add this part to result and increment length
                parts[len] = part;
                len++;
            }
        }

        if (len === 1) {
            // if we end up with just one part that is empty string
            // (which can happen if input is ["", "."]) then return
            // string with just the leading slash
            return '/';
        } else if (len > 2) {
            // parts i s
            // ["", "a", ""]
            // ["", "a", "b", ""]
            if (parts[len - 1].length === 0) {
                // last part is an empty string which would result in trailing slash
                len--;
            }
        }

        // truncate parts to remove unused
        parts.length = len;
        return parts.join('/');
    }

    function join(from, target) {
        var targetParts = target.split('/');
        var fromParts = from == '/' ? [''] : from.split('/');
        return normalizePathParts(fromParts.concat(targetParts));
    }

    function withoutExtension(path) {
        var lastDotPos = path.lastIndexOf('.');
        var lastSlashPos;

        /* jshint laxbreak:true */
        return ((lastDotPos === -1) || ((lastSlashPos = path.lastIndexOf('/')) !== -1) && (lastSlashPos > lastDotPos))
            ? null // use null to indicate that returned path is same as given path
            : path.substring(0, lastDotPos);
    }

    function splitPackageIdAndSubpath(path) {
        path = path.substring(1); /* Skip past the first slash */
        // Examples:
        //     '/my-package$1.0.0/foo/bar' --> ['my-package$1.0.0', '/foo/bar']
        //     '/my-package$1.0.0' --> ['my-package$1.0.0', '']
        //     '/my-package$1.0.0/' --> ['my-package$1.0.0', '/']
        //     '/@my-scoped-package/foo/$1.0.0/' --> ['@my-scoped-package/foo$1.0.0', '/']
        var slashPos = path.indexOf('/');

        if (path.charAt(1) === '@') {
            // path is something like "/@my-user-name/my-scoped-package/subpath"
            // For scoped packages, the package name is two parts. We need to skip
            // past the second slash to get the full package name
            slashPos = path.indexOf('/', slashPos+1);
        }

        var packageIdEnd = slashPos === -1 ? path.length : slashPos;

        return [
            path.substring(0, packageIdEnd), // Everything up to the slash
            path.substring(packageIdEnd) // Everything after the package ID
        ];
    }

    function resolveInstalledModule(target, from) {
        // Examples:
        // target='foo', from='/my-package$1.0.0/hello/world'

        if (target.charAt(target.length-1) === '/') {
            // This is a hack because I found require('util/') in the wild and
            // it did not work because of the trailing slash
            target = target.slice(0, -1);
        }

        // Check to see if the target module is a builtin module.
        // For example:
        // builtins['path'] = '/path-browserify$0.0.0/index'
        var builtinPath = builtins[target];
        if (builtinPath) {
            return builtinPath;
        }

        var fromParts = splitPackageIdAndSubpath(from);
        var fromPackageId = fromParts[0];


        var targetSlashPos = target.indexOf('/');
        var targetPackageName;
        var targetSubpath;

        if (targetSlashPos < 0) {
            targetPackageName = target;
            targetSubpath = '';
        } else {

            if (target.charAt(0) === '@') {
                // target is something like "@my-user-name/my-scoped-package/subpath"
                // For scoped packages, the package name is two parts. We need to skip
                // past the first slash to get the full package name
                targetSlashPos = target.indexOf('/', targetSlashPos + 1);
            }

            targetPackageName = target.substring(0, targetSlashPos);
            targetSubpath = target.substring(targetSlashPos);
        }

        var targetPackageVersion = installed[fromPackageId + '/' + targetPackageName];
        if (targetPackageVersion) {
            var resolvedPath = '/' + targetPackageName + '$' + targetPackageVersion;
            if (targetSubpath) {
                resolvedPath += targetSubpath;
            }
            return resolvedPath;
        }
    }

    function resolve(target, from) {
        var resolvedPath;

        if (target.charAt(0) === '.') {
            // turn relative path into absolute path
            resolvedPath = join(from, target);
        } else if (target.charAt(0) === '/') {
            // handle targets such as "/my/file" or "/$/foo/$/baz"
            resolvedPath = normalizePathParts(target.split('/'));
        } else {
            var len = searchPaths.length;
            for (var i = 0; i < len; i++) {
                // search path entries always end in "/";
                var candidate = searchPaths[i] + target;
                var resolved = resolve(candidate, from);
                if (resolved) {
                    return resolved;
                }
            }

            resolvedPath = resolveInstalledModule(target, from);
        }

        if (!resolvedPath) {
            return undefined;
        }

        // target is something like "/foo/baz"
        // There is no installed module in the path
        var relativePath;

        // check to see if "target" is a "directory" which has a registered main file
        if ((relativePath = mains[resolvedPath]) !== undefined) {
            if (!relativePath) {
                relativePath = 'index';
            }

            // there is a main file corresponding to the given target so add the relative path
            resolvedPath = join(resolvedPath, relativePath);
        }

        var remappedPath = remapped[resolvedPath];
        if (remappedPath) {
            resolvedPath = remappedPath;
        }

        var factoryOrObject = definitions[resolvedPath];
        if (factoryOrObject === undefined) {
            // check for definition for given path but without extension
            var resolvedPathWithoutExtension;
            if (((resolvedPathWithoutExtension = withoutExtension(resolvedPath)) === null) ||
                ((factoryOrObject = definitions[resolvedPathWithoutExtension]) === undefined)) {
                return undefined;
            }

            // we found the definition based on the path without extension so
            // update the path
            resolvedPath = resolvedPathWithoutExtension;
        }

        return [resolvedPath, factoryOrObject];
    }

    function requireModule(target, from) {
        if (!target) {
            throw moduleNotFoundError('');
        }

        var resolved = resolve(target, from);
        if (!resolved) {
            throw moduleNotFoundError(target, from);
        }

        var resolvedPath = resolved[0];

        var module = instanceCache[resolvedPath];

        if (module !== undefined) {
            // found cached entry based on the path
            return module;
        }

        // Fixes issue #5 - Ensure modules mapped to globals only load once
        // https://github.com/raptorjs/raptor-modules/issues/5
        //
        // If a module is mapped to a global variable then we want to always
        // return that global instance of the module when it is being required
        // to avoid duplicate modules being loaded. For modules that are mapped
        // to global variables we also add an entry that maps the path
        // of the module to the global instance of the loaded module.

        if (loadedGlobalsByRealPath.hasOwnProperty(resolvedPath)) {
            return loadedGlobalsByRealPath[resolvedPath];
        }

        var factoryOrObject = resolved[1];

        module = new Module(resolvedPath);

        // cache the instance before loading (allows support for circular dependency with partial loading)
        instanceCache[resolvedPath] = module;

        module.load(factoryOrObject);

        return module;
    }

    function require(target, from) {
        var module = requireModule(target, from);
        return module.exports;
    }

    /*
    $_mod.run('/$/installed-module', '/src/foo');
    */
    function run(path, options) {
        var wait = !options || (options.wait !== false);
        if (wait && !_ready) {
            return runQueue.push([path, options]);
        }

        require(path, '/');
    }

    /*
     * Mark the page as being ready and execute any of the
     * run modules that were deferred
     */
    function ready() {
        _ready = true;

        var len;
        while((len = runQueue.length)) {
            // store a reference to the queue before we reset it
            var queue = runQueue;

            // clear out the queue
            runQueue = [];

            // run all of the current jobs
            for (var i = 0; i < len; i++) {
                var args = queue[i];
                run(args[0], args[1]);
            }

            // stop running jobs in the queue if we change to not ready
            if (!_ready) {
                break;
            }
        }
    }

    function addSearchPath(prefix) {
        searchPaths.push(prefix);
    }

    var pendingCount = 0;
    var onPendingComplete = function() {
        pendingCount--;
        if (!pendingCount) {
            // Trigger any "require-run" modules in the queue to run
            ready();
        }
    };

    /*
     * $_mod is the short-hand version that that the transport layer expects
     * to be in the browser window object
     */
    Module_prototype.__runtime = $_mod = {
        /**
         * Used to register a module factory/object (*internal*)
         */
        def: define,

        /**
         * Used to register an installed dependency (e.g. "/$/foo" depends on "baz") (*internal*)
         */
        installed: registerInstalledDependency,
        run: run,
        main: registerMain,
        remap: remap,
        builtin: builtin,
        require: require,
        resolve: resolve,
        join: join,
        ready: ready,

        /**
         * Add a search path entry (internal)
         */
        searchPath: addSearchPath,

        /**
         * Sets the loader metadata for this build.
         *
         * @param asyncPackageName {String} name of asynchronous package
         * @param contentType {String} content type ("js" or "css")
         * @param bundleUrl {String} URL of bundle that belongs to package
         */
        loaderMetadata: function(data) {
            // We store loader metadata in the prototype of Module
            // so that `lasso-loader` can read it from
            // `module.__loaderMetadata`.
            Module_prototype.__loaderMetadata = data;
        },

        /**
         * Asynchronous bundle loaders should call `pending()` to instantiate
         * a new job. The object we return here has a `done` method that
         * should be called when the job completes. When the number of
         * pending jobs drops to 0, we invoke any of the require-run modules
         * that have been declared.
         */
        pending: function() {
            _ready = false;
            pendingCount++;
            return {
                done: onPendingComplete
            };
        }
    };

    if (win) {
        win.$_mod = $_mod;
    } else {
        module.exports = $_mod;
    }
})();

$_mod.installed("app$1.0.0", "marko", "4.19.8");
$_mod.remap("/marko$4.19.8/components", "/marko$4.19.8/components-browser.marko");
$_mod.main("/marko$4.19.8/dist/runtime/components", "");
$_mod.remap("/marko$4.19.8/dist/runtime/components/index", "/marko$4.19.8/dist/runtime/components/index-browser");
$_mod.remap("/marko$4.19.8/dist/runtime/components/util", "/marko$4.19.8/dist/runtime/components/util-browser");
$_mod.def("/marko$4.19.8/dist/runtime/components/dom-data", function(require, exports, module, __filename, __dirname) { var counter = 0;
var seed = "M" + Math.random().toFixed(5);
var WeakMap = global.WeakMap || function WeakMap() {
  var id = seed + counter++;
  return {
    get: function (ref) {
      return ref[id];
    },
    set: function (ref, value) {
      ref[id] = value;
    }
  };
};

module.exports = {
  ac_: new WeakMap(),
  ad_: new WeakMap(),
  I_: new WeakMap(),
  ae_: new WeakMap(),
  af_: new WeakMap(),
  J_: {}
};
});
$_mod.def("/marko$4.19.8/dist/runtime/components/util-browser", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.I_;
var keysByDOMNode = domData.af_;
var vElementsByDOMNode = domData.ad_;
var vPropsByDOMNode = domData.ac_;
var markoUID = window.$MUID || (window.$MUID = { i: 0 });
var runtimeId = markoUID.i++;

var componentLookup = {};

var defaultDocument = document;
var EMPTY_OBJECT = {};

function getComponentForEl(el, doc) {
  var node = typeof el == "string" ? (doc || defaultDocument).getElementById(el) : el;
  var component;
  var vElement;

  while (node) {
    if (node.fragment) {
      if (node.fragment.endNode === node) {
        node = node.fragment.startNode;
      } else {
        node = node.fragment;
        component = componentsByDOMNode.get(node);
      }
    } else if (vElement = vElementsByDOMNode.get(node)) {
      component = vElement.aG_;
    }

    if (component) {
      return component;
    }

    node = node.previousSibling || node.parentNode;
  }
}

var lifecycleEventMethods = {};

["create", "render", "update", "mount", "destroy"].forEach(function (eventName) {
  lifecycleEventMethods[eventName] = "on" + eventName[0].toUpperCase() + eventName.substring(1);
});

/**
 * This method handles invoking a component's event handler method
 * (if present) while also emitting the event through
 * the standard EventEmitter.prototype.emit method.
 *
 * Special events and their corresponding handler methods
 * include the following:
 *
 * beforeDestroy --> onBeforeDestroy
 * destroy       --> onDestroy
 * beforeUpdate  --> onBeforeUpdate
 * update        --> onUpdate
 * render        --> onRender
 */
function emitLifecycleEvent(component, eventType, eventArg1, eventArg2) {
  var listenerMethod = component[lifecycleEventMethods[eventType]];

  if (listenerMethod !== undefined) {
    listenerMethod.call(component, eventArg1, eventArg2);
  }

  component.emit(eventType, eventArg1, eventArg2);
}

function destroyComponentForNode(node) {
  var componentToDestroy = componentsByDOMNode.get(node.fragment || node);
  if (componentToDestroy) {
    componentToDestroy._c_();
    delete componentLookup[componentToDestroy.id];
  }
}
function destroyNodeRecursive(node, component) {
  destroyComponentForNode(node);
  if (node.nodeType === 1 || node.nodeType === 12) {
    var key;

    if (component && (key = keysByDOMNode.get(node))) {
      if (node === component.o_[key]) {
        if (componentsByDOMNode.get(node) && /\[\]$/.test(key)) {
          delete component.o_[key][componentsByDOMNode.get(node).id];
        } else {
          delete component.o_[key];
        }
      }
    }

    var curChild = node.firstChild;
    while (curChild && curChild !== node.endNode) {
      destroyNodeRecursive(curChild, component);
      curChild = curChild.nextSibling;
    }
  }
}

function nextComponentId() {
  // Each component will get an ID that is unique across all loaded
  // marko runtimes. This allows multiple instances of marko to be
  // loaded in the same window and they should all place nice
  // together
  return "c" + markoUID.i++;
}

function nextComponentIdProvider() {
  return nextComponentId;
}

function attachBubblingEvent(componentDef, handlerMethodName, isOnce, extraArgs) {
  if (handlerMethodName) {
    var componentId = componentDef.id;
    if (extraArgs) {
      return [handlerMethodName, componentId, isOnce, extraArgs];
    } else {
      return [handlerMethodName, componentId, isOnce];
    }
  }
}

function getMarkoPropsFromEl(el) {
  var vElement = vElementsByDOMNode.get(el);
  var virtualProps;

  if (vElement) {
    virtualProps = vElement.aH_;
  } else {
    virtualProps = vPropsByDOMNode.get(el);
    if (!virtualProps) {
      virtualProps = el.getAttribute("data-marko");
      vPropsByDOMNode.set(el, virtualProps = virtualProps ? JSON.parse(virtualProps) : EMPTY_OBJECT);
    }
  }

  return virtualProps;
}

function normalizeComponentKey(key, parentId) {
  if (key[0] === "#") {
    key = key.replace("#" + parentId + "-", "");
  }
  return key;
}

function addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId) {
  if (/\[\]$/.test(key)) {
    var repeatedElementsForKey = keyedElements[key] = keyedElements[key] || {};
    repeatedElementsForKey[componentId] = rootNode;
  } else {
    keyedElements[key] = rootNode;
  }
}

exports.ag_ = runtimeId;
exports.F_ = componentLookup;
exports.aj_ = getComponentForEl;
exports.G_ = emitLifecycleEvent;
exports.aI_ = destroyComponentForNode;
exports.H_ = destroyNodeRecursive;
exports._R_ = nextComponentIdProvider;
exports._A_ = attachBubblingEvent;
exports.ah_ = getMarkoPropsFromEl;
exports.an_ = addComponentRootToKeyedElements;
exports.aJ_ = normalizeComponentKey;
});
$_mod.remap("/marko$4.19.8/dist/runtime/components/init-components", "/marko$4.19.8/dist/runtime/components/init-components-browser");
$_mod.installed("marko$4.19.8", "warp10", "2.0.1");
$_mod.def("/warp10$2.0.1/src/constants", function(require, exports, module, __filename, __dirname) { var win = typeof window !== "undefined" ? window : global;
exports.NOOP = win.$W10NOOP = win.$W10NOOP || function () {};
});
$_mod.def("/warp10$2.0.1/src/finalize", function(require, exports, module, __filename, __dirname) { var constants = require('/warp10$2.0.1/src/constants'/*"./constants"*/);
var isArray = Array.isArray;

function resolve(object, path, len) {
    var current = object;
    for (var i=0; i<len; i++) {
        current = current[path[i]];
    }

    return current;
}

function resolveType(info) {
    if (info.type === 'Date') {
        return new Date(info.value);
    } else if (info.type === 'NOOP') {
        return constants.NOOP;
    } else {
        throw new Error('Bad type');
    }
}

module.exports = function finalize(outer) {
    if (!outer) {
        return outer;
    }

    var assignments = outer.$$;
    if (assignments) {
        var object = outer.o;
        var len;

        if (assignments && (len=assignments.length)) {
            for (var i=0; i<len; i++) {
                var assignment = assignments[i];

                var rhs = assignment.r;
                var rhsValue;

                if (isArray(rhs)) {
                    rhsValue = resolve(object, rhs, rhs.length);
                } else {
                    rhsValue = resolveType(rhs);
                }

                var lhs = assignment.l;
                var lhsLast = lhs.length-1;

                if (lhsLast === -1) {
                    object = outer.o = rhsValue;
                    break;
                } else {
                    var lhsParent = resolve(object, lhs, lhsLast);
                    lhsParent[lhs[lhsLast]] = rhsValue;
                }
            }
        }

        assignments.length = 0; // Assignments have been applied, do not reapply

        return object == null ? null : object;
    } else {
        return outer;
    }

};
});
$_mod.def("/warp10$2.0.1/finalize", function(require, exports, module, __filename, __dirname) { module.exports = require('/warp10$2.0.1/src/finalize'/*'./src/finalize'*/);
});
$_mod.def("/marko$4.19.8/dist/runtime/components/event-delegation", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var runtimeId = componentsUtil.ag_;
var componentLookup = componentsUtil.F_;
var getMarkoPropsFromEl = componentsUtil.ah_;

// We make our best effort to allow multiple marko runtimes to be loaded in the
// same window. Each marko runtime will get its own unique runtime ID.
var listenersAttachedKey = "$MDE" + runtimeId;
var delegatedEvents = {};

function getEventFromEl(el, eventName) {
  var virtualProps = getMarkoPropsFromEl(el);
  var eventInfo = virtualProps[eventName];

  if (typeof eventInfo === "string") {
    eventInfo = eventInfo.split(" ");
    if (eventInfo[2]) {
      eventInfo[2] = eventInfo[2] === "true";
    }
    if (eventInfo.length == 4) {
      eventInfo[3] = parseInt(eventInfo[3], 10);
    }
  }

  return eventInfo;
}

function delegateEvent(node, eventName, target, event) {
  var targetMethod = target[0];
  var targetComponentId = target[1];
  var isOnce = target[2];
  var extraArgs = target[3];

  if (isOnce) {
    var virtualProps = getMarkoPropsFromEl(node);
    delete virtualProps[eventName];
  }

  var targetComponent = componentLookup[targetComponentId];

  if (!targetComponent) {
    return;
  }

  var targetFunc = typeof targetMethod === "function" ? targetMethod : targetComponent[targetMethod];
  if (!targetFunc) {
    throw Error("Method not found: " + targetMethod);
  }

  if (extraArgs != null) {
    if (typeof extraArgs === "number") {
      extraArgs = targetComponent.Q_[extraArgs];
    }
  }

  // Invoke the component method
  if (extraArgs) {
    targetFunc.apply(targetComponent, extraArgs.concat(event, node));
  } else {
    targetFunc.call(targetComponent, event, node);
  }
}

function addDelegatedEventHandler(eventType) {
  if (!delegatedEvents[eventType]) {
    delegatedEvents[eventType] = true;
  }
}

function addDelegatedEventHandlerToDoc(eventType, doc) {
  var body = doc.body || doc;
  var listeners = doc[listenersAttachedKey] = doc[listenersAttachedKey] || {};
  if (!listeners[eventType]) {
    body.addEventListener(eventType, listeners[eventType] = function (event) {
      var propagationStopped = false;

      // Monkey-patch to fix #97
      var oldStopPropagation = event.stopPropagation;

      event.stopPropagation = function () {
        oldStopPropagation.call(event);
        propagationStopped = true;
      };

      var curNode = event.target;
      if (!curNode) {
        return;
      }

      // event.target of an SVGElementInstance does not have a
      // `getAttribute` function in IE 11.
      // See https://github.com/marko-js/marko/issues/796
      curNode = curNode.correspondingUseElement || curNode;

      // Search up the tree looking DOM events mapped to target
      // component methods
      var propName = "on" + eventType;
      var target;

      // Attributes will have the following form:
      // on<event_type>("<target_method>|<component_id>")

      do {
        if (target = getEventFromEl(curNode, propName)) {
          delegateEvent(curNode, propName, target, event);

          if (propagationStopped) {
            break;
          }
        }
      } while ((curNode = curNode.parentNode) && curNode.getAttribute);
    }, true);
  }
}

function noop() {}

exports.aa_ = noop;
exports._d_ = noop;
exports._Y_ = delegateEvent;
exports._Z_ = getEventFromEl;
exports._B_ = addDelegatedEventHandler;
exports.ai_ = function (doc) {
  Object.keys(delegatedEvents).forEach(function (eventType) {
    addDelegatedEventHandlerToDoc(eventType, doc);
  });
};
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/morphdom/helpers", function(require, exports, module, __filename, __dirname) { function insertBefore(node, referenceNode, parentNode) {
  if (node.insertInto) {
    return node.insertInto(parentNode, referenceNode);
  }
  return parentNode.insertBefore(node, referenceNode && referenceNode.startNode || referenceNode);
}

function insertAfter(node, referenceNode, parentNode) {
  return insertBefore(node, referenceNode && referenceNode.nextSibling, parentNode);
}

function nextSibling(node) {
  var next = node.nextSibling;
  var fragment = next && next.fragment;
  if (fragment) {
    return next === fragment.startNode ? fragment : null;
  }
  return next;
}

function firstChild(node) {
  var next = node.firstChild;
  return next && next.fragment || next;
}

function removeChild(node) {
  if (node.remove) node.remove();else node.parentNode.removeChild(node);
}

exports.aL_ = insertBefore;
exports.aM_ = insertAfter;
exports.b_ = nextSibling;
exports.a_ = firstChild;
exports.aN_ = removeChild;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/morphdom/fragment", function(require, exports, module, __filename, __dirname) { var helpers = require('/marko$4.19.8/dist/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var insertBefore = helpers.aL_;

var fragmentPrototype = {
  nodeType: 12,
  get firstChild() {
    var firstChild = this.startNode.nextSibling;
    return firstChild === this.endNode ? undefined : firstChild;
  },
  get lastChild() {
    var lastChild = this.endNode.previousSibling;
    return lastChild === this.startNode ? undefined : lastChild;
  },
  get parentNode() {
    var parentNode = this.startNode.parentNode;
    return parentNode === this.detachedContainer ? undefined : parentNode;
  },
  get namespaceURI() {
    return this.startNode.parentNode.namespaceURI;
  },
  get nextSibling() {
    return this.endNode.nextSibling;
  },
  get nodes() {
    var nodes = [];
    var current = this.startNode;
    while (current !== this.endNode) {
      nodes.push(current);
      current = current.nextSibling;
    }
    nodes.push(current);
    return nodes;
  },
  insertBefore: function (newChildNode, referenceNode) {
    var actualReference = referenceNode == null ? this.endNode : referenceNode;
    return insertBefore(newChildNode, actualReference, this.startNode.parentNode);
  },
  insertInto: function (newParentNode, referenceNode) {
    this.nodes.forEach(function (node) {
      insertBefore(node, referenceNode, newParentNode);
    }, this);
    return this;
  },
  remove: function () {
    this.nodes.forEach(function (node) {
      this.detachedContainer.appendChild(node);
    }, this);
  }
};

function createFragmentNode(startNode, nextNode, parentNode) {
  var fragment = Object.create(fragmentPrototype);
  var isRoot = startNode && startNode.ownerDocument === startNode.parentNode;
  fragment.startNode = isRoot ? document.createComment("") : document.createTextNode("");
  fragment.endNode = isRoot ? document.createComment("") : document.createTextNode("");
  fragment.startNode.fragment = fragment;
  fragment.endNode.fragment = fragment;
  var detachedContainer = fragment.detachedContainer = document.createDocumentFragment();
  parentNode = parentNode || startNode && startNode.parentNode || detachedContainer;
  insertBefore(fragment.startNode, startNode, parentNode);
  insertBefore(fragment.endNode, nextNode, parentNode);
  return fragment;
}

function beginFragmentNode(startNode, parentNode) {
  var fragment = createFragmentNode(startNode, null, parentNode);
  fragment.bT_ = function (nextNode) {
    fragment.bT_ = null;
    insertBefore(fragment.endNode, nextNode, parentNode || startNode.parentNode);
  };
  return fragment;
}

exports.am_ = createFragmentNode;
exports.bU_ = beginFragmentNode;
});
$_mod.installed("marko$4.19.8", "raptor-util", "3.2.0");
$_mod.def("/raptor-util$3.2.0/extend", function(require, exports, module, __filename, __dirname) { module.exports = function extend(target, source) { //A simple function to copy properties from one object to another
    if (!target) { //Check if a target was provided, otherwise create a new empty object to return
        target = {};
    }

    if (source) {
        for (var propName in source) {
            if (source.hasOwnProperty(propName)) { //Only look at source properties that are not inherited
                target[propName] = source[propName]; //Copy the property
            }
        }
    }

    return target;
};
});
$_mod.def("/marko$4.19.8/dist/runtime/components/KeySequence", function(require, exports, module, __filename, __dirname) { function KeySequence() {
  this._U_ = {};
}

KeySequence.prototype = {
  _I_: function (key) {
    // var len = key.length;
    // var lastChar = key[len-1];
    // if (lastChar === ']') {
    //     key = key.substring(0, len-2);
    // }
    var lookup = this._U_;

    var currentIndex = lookup[key]++;
    if (!currentIndex) {
      lookup[key] = 1;
      currentIndex = 0;
      return key;
    } else {
      return key + "_" + currentIndex;
    }
  }
};

module.exports = KeySequence;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/ComponentDef", function(require, exports, module, __filename, __dirname) { "use strict";

var complain;
var componentUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var attachBubblingEvent = componentUtil._A_;
var addDelegatedEventHandler = require('/marko$4.19.8/dist/runtime/components/event-delegation'/*"./event-delegation"*/)._B_;
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var KeySequence = require('/marko$4.19.8/dist/runtime/components/KeySequence'/*"./KeySequence"*/);

var FLAG_WILL_RERENDER_IN_BROWSER = 1;
// var FLAG_HAS_BODY_EL = 2;
// var FLAG_HAS_HEAD_EL = 4;
var FLAG_OLD_HYDRATE_NO_CREATE = 8;

/**
 * A ComponentDef is used to hold the metadata collected at runtime for
 * a single component and this information is used to instantiate the component
 * later (after the rendered HTML has been added to the DOM)
 */
function ComponentDef(component, componentId, componentsContext) {
  this._C_ = componentsContext; // The AsyncWriter that this component is associated with
  this.m_ = component;
  this.id = componentId;

  this._D_ = undefined; // An array of DOM events that need to be added (in sets of three)

  this._E_ = false;

  this._F_ = false;
  this._G_ = 0;

  this._H_ = 0; // The unique integer to use for the next scoped ID

  this._a_ = null;
}

ComponentDef.prototype = {
  _I_: function (key) {
    var keySequence = this._a_ || (this._a_ = new KeySequence());
    return keySequence._I_(key);
  },

  /**
   * This helper method generates a unique and fully qualified DOM element ID
   * that is unique within the scope of the current component.
   */
  elId: function (nestedId) {
    var id = this.id;

    if (nestedId == null) {
      return id;
    } else {
      if (typeof nestedId !== "string") {

        nestedId = String(nestedId);
        // eslint-disable-next-line no-constant-condition
      }

      if (nestedId.indexOf("#") === 0) {
        id = "#" + id;
        nestedId = nestedId.substring(1);
      }

      return id + "-" + nestedId;
    }
  },
  /**
   * Returns the next auto generated unique ID for a nested DOM element or nested DOM component
   */
  _J_: function () {
    return this.id + "-c" + this._H_++;
  },

  d: function (eventName, handlerMethodName, isOnce, extraArgs) {
    addDelegatedEventHandler(eventName);
    return attachBubblingEvent(this, handlerMethodName, isOnce, extraArgs);
  },

  get e_() {
    return this.m_.e_;
  }
};

ComponentDef.prototype.nk = ComponentDef.prototype._I_;

ComponentDef._K_ = function (o, types, global, registry) {
  var id = o[0];
  var typeName = types[o[1]];
  var input = o[2];
  var extra = o[3];

  var isLegacy = extra.l;
  var state = extra.s;
  var componentProps = extra.w;
  var flags = extra.f;

  var component = typeName /* legacy */ && registry._L_(typeName, id, isLegacy);

  // Prevent newly created component from being queued for update since we area
  // just building it from the server info
  component.X_ = true;

  if (!isLegacy && flags & FLAG_WILL_RERENDER_IN_BROWSER && !(flags & FLAG_OLD_HYDRATE_NO_CREATE)) {
    if (component.onCreate) {
      component.onCreate(input, { global: global });
    }
    if (component.onInput) {
      input = component.onInput(input, { global: global }) || input;
    }
  } else {
    if (state) {
      var undefinedPropNames = extra.u;
      if (undefinedPropNames) {
        undefinedPropNames.forEach(function (undefinedPropName) {
          state[undefinedPropName] = undefined;
        });
      }
      // We go through the setter here so that we convert the state object
      // to an instance of `State`
      component.state = state;
    }

    if (componentProps) {
      extend(component, componentProps);
    }
  }

  component.T_ = input;

  if (extra.b) {
    component.Q_ = extra.b;
  }

  var scope = extra.p;
  var customEvents = extra.e;
  if (customEvents) {
    component._x_(customEvents, scope);
  }

  component.V_ = global;

  return {
    id: id,
    m_: component,
    _M_: extra.r,
    _D_: extra.d,
    _G_: extra.f || 0
  };
};

module.exports = ComponentDef;
});
$_mod.remap("/marko$4.19.8/dist/runtime/components/registry", "/marko$4.19.8/dist/runtime/components/registry-browser");
$_mod.def("/marko$4.19.8/dist/runtime/components/State", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function ensure(state, propertyName) {
  var proto = state.constructor.prototype;
  if (!(propertyName in proto)) {
    Object.defineProperty(proto, propertyName, {
      get: function () {
        return this._w_[propertyName];
      },
      set: function (value) {
        this._i_(propertyName, value, false /* ensure:false */);
      }
    });
  }
}

function State(component) {
  this.m_ = component;
  this._w_ = {};

  this.Y_ = false;
  this._o_ = null;
  this._n_ = null;
  this._X_ = null; // An object that we use to keep tracking of state properties that were forced to be dirty

  Object.seal(this);
}

State.prototype = {
  L_: function () {
    var self = this;

    self.Y_ = false;
    self._o_ = null;
    self._n_ = null;
    self._X_ = null;
  },

  _g_: function (newState) {
    var state = this;
    var key;

    var rawState = this._w_;

    for (key in rawState) {
      if (!(key in newState)) {
        state._i_(key, undefined, false /* ensure:false */
        , false /* forceDirty:false */
        );
      }
    }

    for (key in newState) {
      state._i_(key, newState[key], true /* ensure:true */
      , false /* forceDirty:false */
      );
    }
  },
  _i_: function (name, value, shouldEnsure, forceDirty) {
    var rawState = this._w_;

    if (shouldEnsure) {
      ensure(this, name);
    }

    if (forceDirty) {
      var forcedDirtyState = this._X_ || (this._X_ = {});
      forcedDirtyState[name] = true;
    } else if (rawState[name] === value) {
      return;
    }

    if (!this.Y_) {
      // This is the first time we are modifying the component state
      // so introduce some properties to do some tracking of
      // changes to the state
      this.Y_ = true; // Mark the component state as dirty (i.e. modified)
      this._o_ = rawState;
      this._w_ = rawState = extend({}, rawState);
      this._n_ = {};
      this.m_._h_();
    }

    this._n_[name] = value;

    if (value === undefined) {
      // Don't store state properties with an undefined or null value
      delete rawState[name];
    } else {
      // Otherwise, store the new value in the component state
      rawState[name] = value;
    }
  },
  toJSON: function () {
    return this._w_;
  }
};

module.exports = State;
});
$_mod.def("/marko$4.19.8/dist/runtime/dom-insert", function(require, exports, module, __filename, __dirname) { var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);
var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./components/util"*/);
var destroyComponentForNode = componentsUtil.aI_;
var destroyNodeRecursive = componentsUtil.H_;
var helpers = require('/marko$4.19.8/dist/runtime/vdom/morphdom/helpers'/*"./vdom/morphdom/helpers"*/);

var insertBefore = helpers.aL_;
var insertAfter = helpers.aM_;
var removeChild = helpers.aN_;

function resolveEl(el) {
  if (typeof el == "string") {
    var elId = el;
    el = document.getElementById(elId);
    if (!el) {
      throw Error("Not found: " + elId);
    }
  }
  return el;
}

function beforeRemove(referenceEl) {
  destroyNodeRecursive(referenceEl);
  destroyComponentForNode(referenceEl);
}

module.exports = function (target, getEl, afterInsert) {
  extend(target, {
    appendTo: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);
      insertBefore(el, null, referenceEl);
      return afterInsert(this, referenceEl);
    },
    prependTo: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);
      insertBefore(el, referenceEl.firstChild || null, referenceEl);
      return afterInsert(this, referenceEl);
    },
    replace: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);
      beforeRemove(referenceEl);
      insertBefore(el, referenceEl, referenceEl.parentNode);
      removeChild(referenceEl);
      return afterInsert(this, referenceEl);
    },
    replaceChildrenOf: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);

      var curChild = referenceEl.firstChild;
      while (curChild) {
        var nextSibling = curChild.nextSibling; // Just in case the DOM changes while removing
        beforeRemove(curChild);
        curChild = nextSibling;
      }

      referenceEl.innerHTML = "";
      insertBefore(el, null, referenceEl);
      return afterInsert(this, referenceEl);
    },
    insertBefore: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);
      insertBefore(el, referenceEl, referenceEl.parentNode);
      return afterInsert(this, referenceEl);
    },
    insertAfter: function (referenceEl) {
      referenceEl = resolveEl(referenceEl);
      var el = getEl(this, referenceEl);
      insertAfter(el, referenceEl, referenceEl.parentNode);
      return afterInsert(this, referenceEl);
    }
  });
};
});
$_mod.def("/marko$4.19.8/dist/runtime/createOut", function(require, exports, module, __filename, __dirname) { var actualCreateOut;

function setCreateOut(createOutFunc) {
  actualCreateOut = createOutFunc;
}

function createOut(globalData) {
  return actualCreateOut(globalData);
}

createOut.aK_ = setCreateOut;

module.exports = createOut;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/GlobalComponentsContext", function(require, exports, module, __filename, __dirname) { var nextComponentIdProvider = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/)._R_;
var KeySequence = require('/marko$4.19.8/dist/runtime/components/KeySequence'/*"./KeySequence"*/);

function GlobalComponentsContext(out) {
  this._S_ = {};
  this._t_ = undefined;
  this._J_ = nextComponentIdProvider(out);
}

GlobalComponentsContext.prototype = {
  _T_: function () {
    return new KeySequence();
  }
};

module.exports = GlobalComponentsContext;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/ComponentsContext", function(require, exports, module, __filename, __dirname) { "use strict";

var GlobalComponentsContext = require('/marko$4.19.8/dist/runtime/components/GlobalComponentsContext'/*"./GlobalComponentsContext"*/);

function ComponentsContext(out, parentComponentsContext) {
  var globalComponentsContext;
  var componentDef;

  if (parentComponentsContext) {
    globalComponentsContext = parentComponentsContext.j_;
    componentDef = parentComponentsContext._N_;

    var nestedContextsForParent;
    if (!(nestedContextsForParent = parentComponentsContext._O_)) {
      nestedContextsForParent = parentComponentsContext._O_ = [];
    }

    nestedContextsForParent.push(this);
  } else {
    globalComponentsContext = out.global.h_;
    if (globalComponentsContext === undefined) {
      out.global.h_ = globalComponentsContext = new GlobalComponentsContext(out);
    }
  }

  this.j_ = globalComponentsContext;
  this.h_ = [];
  this.B_ = out;
  this._N_ = componentDef;
  this._O_ = undefined;
  this.s_ = parentComponentsContext && parentComponentsContext.s_;
}

ComponentsContext.prototype = {
  C_: function (doc) {
    var componentDefs = this.h_;

    ComponentsContext._P_(componentDefs, doc);

    this.B_.emit("_Q_");

    // Reset things stored in global since global is retained for
    // future renders
    this.B_.global.h_ = undefined;

    return componentDefs;
  }
};

function getComponentsContext(out) {
  return out.h_ || (out.h_ = new ComponentsContext(out));
}

module.exports = exports = ComponentsContext;

exports.r_ = getComponentsContext;
});
$_mod.installed("marko$4.19.8", "events-light", "1.0.5");
$_mod.main("/events-light$1.0.5", "src/index");
$_mod.def("/events-light$1.0.5/src/index", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
var slice = Array.prototype.slice;

function isFunction(arg) {
    return typeof arg === 'function';
}

function checkListener(listener) {
    if (!isFunction(listener)) {
        throw TypeError('Invalid listener');
    }
}

function invokeListener(ee, listener, args) {
    switch (args.length) {
        // fast cases
        case 1:
            listener.call(ee);
            break;
        case 2:
            listener.call(ee, args[1]);
            break;
        case 3:
            listener.call(ee, args[1], args[2]);
            break;
            // slower
        default:
            listener.apply(ee, slice.call(args, 1));
    }
}

function addListener(eventEmitter, type, listener, prepend) {
    checkListener(listener);

    var events = eventEmitter.$e || (eventEmitter.$e = {});

    var listeners = events[type];
    if (listeners) {
        if (isFunction(listeners)) {
            events[type] = prepend ? [listener, listeners] : [listeners, listener];
        } else {
            if (prepend) {
                listeners.unshift(listener);
            } else {
                listeners.push(listener);
            }
        }

    } else {
        events[type] = listener;
    }
    return eventEmitter;
}

function EventEmitter() {
    this.$e = this.$e || {};
}

EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype = {
    $e: null,

    emit: function(type) {
        var args = arguments;

        var events = this.$e;
        if (!events) {
            return;
        }

        var listeners = events && events[type];
        if (!listeners) {
            // If there is no 'error' event listener then throw.
            if (type === 'error') {
                var error = args[1];
                if (!(error instanceof Error)) {
                    var context = error;
                    error = new Error('Error: ' + context);
                    error.context = context;
                }

                throw error; // Unhandled 'error' event
            }

            return false;
        }

        if (isFunction(listeners)) {
            invokeListener(this, listeners, args);
        } else {
            listeners = slice.call(listeners);

            for (var i=0, len=listeners.length; i<len; i++) {
                var listener = listeners[i];
                invokeListener(this, listener, args);
            }
        }

        return true;
    },

    on: function(type, listener) {
        return addListener(this, type, listener, false);
    },

    prependListener: function(type, listener) {
        return addListener(this, type, listener, true);
    },

    once: function(type, listener) {
        checkListener(listener);

        function g() {
            this.removeListener(type, g);

            if (listener) {
                listener.apply(this, arguments);
                listener = null;
            }
        }

        this.on(type, g);

        return this;
    },

    // emits a 'removeListener' event iff the listener was removed
    removeListener: function(type, listener) {
        checkListener(listener);

        var events = this.$e;
        var listeners;

        if (events && (listeners = events[type])) {
            if (isFunction(listeners)) {
                if (listeners === listener) {
                    delete events[type];
                }
            } else {
                for (var i=listeners.length-1; i>=0; i--) {
                    if (listeners[i] === listener) {
                        listeners.splice(i, 1);
                    }
                }
            }
        }

        return this;
    },

    removeAllListeners: function(type) {
        var events = this.$e;
        if (events) {
            delete events[type];
        }
    },

    listenerCount: function(type) {
        var events = this.$e;
        var listeners = events && events[type];
        return listeners ? (isFunction(listeners) ? 1 : listeners.length) : 0;
    }
};

module.exports = EventEmitter;
});
$_mod.def("/marko$4.19.8/dist/runtime/RenderResult", function(require, exports, module, __filename, __dirname) { var domInsert = require('/marko$4.19.8/dist/runtime/dom-insert'/*"./dom-insert"*/);
var complain;

function getComponentDefs(result) {
  var componentDefs = result.h_;

  if (!componentDefs) {
    throw Error("No component");
  }
  return componentDefs;
}

function RenderResult(out) {
  this.out = this.B_ = out;
  this.h_ = undefined;
}

module.exports = RenderResult;

var proto = RenderResult.prototype = {
  getComponent: function () {
    return this.getComponents()[0];
  },
  getComponents: function (selector) {
    if (this.h_ === undefined) {
      throw Error("Not added to DOM");
    }

    var componentDefs = getComponentDefs(this);

    var components = [];

    componentDefs.forEach(function (componentDef) {
      var component = componentDef.m_;
      if (!selector || selector(component)) {
        components.push(component);
      }
    });

    return components;
  },

  afterInsert: function (doc) {
    var out = this.B_;
    var componentsContext = out.h_;
    if (componentsContext) {
      this.h_ = componentsContext.C_(doc);
    } else {
      this.h_ = null;
    }

    return this;
  },
  getNode: function (doc) {
    return this.B_.D_(doc);
  },
  getOutput: function () {
    return this.B_.E_();
  },
  toString: function () {
    return this.B_.toString();
  },
  document: typeof document != "undefined" && document
};

Object.defineProperty(proto, "html", {
  get: function () {
    return this.toString();
    // eslint-disable-next-line no-constant-condition
  }
});

Object.defineProperty(proto, "context", {
  get: function () {
    return this.B_;
    // eslint-disable-next-line no-constant-condition
  }
});

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(proto, function getEl(renderResult, referenceEl) {
  return renderResult.getNode(referenceEl.ownerDocument);
}, function afterInsert(renderResult, referenceEl) {
  var isShadow = typeof ShadowRoot === "function" && referenceEl instanceof ShadowRoot;
  return renderResult.afterInsert(isShadow ? referenceEl : referenceEl.ownerDocument);
});
});
$_mod.installed("marko$4.19.8", "listener-tracker", "2.0.0");
$_mod.main("/listener-tracker$2.0.0", "lib/listener-tracker");
$_mod.def("/listener-tracker$2.0.0/lib/listener-tracker", function(require, exports, module, __filename, __dirname) { var INDEX_EVENT = 0;
var INDEX_USER_LISTENER = 1;
var INDEX_WRAPPED_LISTENER = 2;
var DESTROY = "destroy";

function isNonEventEmitter(target) {
  return !target.once;
}

function EventEmitterWrapper(target) {
    this.$__target = target;
    this.$__listeners = [];
    this.$__subscribeTo = null;
}

EventEmitterWrapper.prototype = {
    $__remove: function(test, testWrapped) {
        var target = this.$__target;
        var listeners = this.$__listeners;

        this.$__listeners = listeners.filter(function(curListener) {
            var curEvent = curListener[INDEX_EVENT];
            var curListenerFunc = curListener[INDEX_USER_LISTENER];
            var curWrappedListenerFunc = curListener[INDEX_WRAPPED_LISTENER];

            if (testWrapped) {
                // If the user used `once` to attach an event listener then we had to
                // wrap their listener function with a new function that does some extra
                // cleanup to avoid a memory leak. If the `testWrapped` flag is set to true
                // then we are attempting to remove based on a function that we had to
                // wrap (not the user listener function)
                if (curWrappedListenerFunc && test(curEvent, curWrappedListenerFunc)) {
                    target.removeListener(curEvent, curWrappedListenerFunc);

                    return false;
                }
            } else if (test(curEvent, curListenerFunc)) {
                // If the listener function was wrapped due to it being a `once` listener
                // then we should remove from the target EventEmitter using wrapped
                // listener function. Otherwise, we remove the listener using the user-provided
                // listener function.
                target.removeListener(curEvent, curWrappedListenerFunc || curListenerFunc);

                return false;
            }

            return true;
        });

        // Fixes https://github.com/raptorjs/listener-tracker/issues/2
        // If all of the listeners stored with a wrapped EventEmitter
        // have been removed then we should unregister the wrapped
        // EventEmitter in the parent SubscriptionTracker
        var subscribeTo = this.$__subscribeTo;

        if (!this.$__listeners.length && subscribeTo) {
            var self = this;
            var subscribeToList = subscribeTo.$__subscribeToList;
            subscribeTo.$__subscribeToList = subscribeToList.filter(function(cur) {
                return cur !== self;
            });
        }
    },

    on: function(event, listener) {
        this.$__target.on(event, listener);
        this.$__listeners.push([event, listener]);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // Handling a `once` event listener is a little tricky since we need to also
        // do our own cleanup if the `once` event is emitted. Therefore, we need
        // to wrap the user's listener function with our own listener function.
        var wrappedListener = function() {
            self.$__remove(function(event, listenerFunc) {
                return wrappedListener === listenerFunc;
            }, true /* We are removing the wrapped listener */);

            listener.apply(this, arguments);
        };

        this.$__target.once(event, wrappedListener);
        this.$__listeners.push([event, listener, wrappedListener]);
        return this;
    },

    removeListener: function(event, listener) {
        if (typeof event === 'function') {
            listener = event;
            event = null;
        }

        if (listener && event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent && listener === curListener;
            });
        } else if (listener) {
            this.$__remove(function(curEvent, curListener) {
                return listener === curListener;
            });
        } else if (event) {
            this.removeAllListeners(event);
        }

        return this;
    },

    removeAllListeners: function(event) {

        var listeners = this.$__listeners;
        var target = this.$__target;

        if (event) {
            this.$__remove(function(curEvent, curListener) {
                return event === curEvent;
            });
        } else {
            for (var i = listeners.length - 1; i >= 0; i--) {
                var cur = listeners[i];
                target.removeListener(cur[INDEX_EVENT], cur[INDEX_USER_LISTENER]);
            }
            this.$__listeners.length = 0;
        }

        return this;
    }
};

function EventEmitterAdapter(target) {
    this.$__target = target;
}

EventEmitterAdapter.prototype = {
    on: function(event, listener) {
        this.$__target.addEventListener(event, listener);
        return this;
    },

    once: function(event, listener) {
        var self = this;

        // need to save this so we can remove it below
        var onceListener = function() {
          self.$__target.removeEventListener(event, onceListener);
          listener();
        };
        this.$__target.addEventListener(event, onceListener);
        return this;
    },

    removeListener: function(event, listener) {
        this.$__target.removeEventListener(event, listener);
        return this;
    }
};

function SubscriptionTracker() {
    this.$__subscribeToList = [];
}

SubscriptionTracker.prototype = {

    subscribeTo: function(target, options) {
        var addDestroyListener = !options || options.addDestroyListener !== false;
        var wrapper;
        var nonEE;
        var subscribeToList = this.$__subscribeToList;

        for (var i=0, len=subscribeToList.length; i<len; i++) {
            var cur = subscribeToList[i];
            if (cur.$__target === target) {
                wrapper = cur;
                break;
            }
        }

        if (!wrapper) {
            if (isNonEventEmitter(target)) {
              nonEE = new EventEmitterAdapter(target);
            }

            wrapper = new EventEmitterWrapper(nonEE || target);
            if (addDestroyListener && !nonEE) {
                wrapper.once(DESTROY, function() {
                    wrapper.removeAllListeners();

                    for (var i = subscribeToList.length - 1; i >= 0; i--) {
                        if (subscribeToList[i].$__target === target) {
                            subscribeToList.splice(i, 1);
                            break;
                        }
                    }
                });
            }

            // Store a reference to the parent SubscriptionTracker so that we can do cleanup
            // if the EventEmitterWrapper instance becomes empty (i.e., no active listeners)
            wrapper.$__subscribeTo = this;
            subscribeToList.push(wrapper);
        }

        return wrapper;
    },

    removeAllListeners: function(target, event) {
        var subscribeToList = this.$__subscribeToList;
        var i;

        if (target) {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                var cur = subscribeToList[i];
                if (cur.$__target === target) {
                    cur.removeAllListeners(event);

                    if (!cur.$__listeners.length) {
                        // Do some cleanup if we removed all
                        // listeners for the target event emitter
                        subscribeToList.splice(i, 1);
                    }

                    break;
                }
            }
        } else {
            for (i = subscribeToList.length - 1; i >= 0; i--) {
                subscribeToList[i].removeAllListeners();
            }
            subscribeToList.length = 0;
        }
    }
};

exports = module.exports = SubscriptionTracker;

exports.wrap = function(targetEventEmitter) {
    var nonEE;
    var wrapper;

    if (isNonEventEmitter(targetEventEmitter)) {
      nonEE = new EventEmitterAdapter(targetEventEmitter);
    }

    wrapper = new EventEmitterWrapper(nonEE || targetEventEmitter);
    if (!nonEE) {
      // we don't set this for non EE types
      targetEventEmitter.once(DESTROY, function() {
          wrapper.$__listeners.length = 0;
      });
    }

    return wrapper;
};

exports.createTracker = function() {
    return new SubscriptionTracker();
};

});
$_mod.def("/raptor-util$3.2.0/copyProps", function(require, exports, module, __filename, __dirname) { module.exports = function copyProps(from, to) {
    Object.getOwnPropertyNames(from).forEach(function(name) {
        var descriptor = Object.getOwnPropertyDescriptor(from, name);
        Object.defineProperty(to, name, descriptor);
    });
};
});
$_mod.def("/raptor-util$3.2.0/inherit", function(require, exports, module, __filename, __dirname) { var copyProps = require('/raptor-util$3.2.0/copyProps'/*'./copyProps'*/);

function inherit(ctor, superCtor, shouldCopyProps) {
    var oldProto = ctor.prototype;
    var newProto = ctor.prototype = Object.create(superCtor.prototype, {
        constructor: {
            value: ctor,
            writable: true,
            configurable: true
        }
    });
    if (oldProto && shouldCopyProps !== false) {
        copyProps(oldProto, newProto);
    }
    ctor.$super = superCtor;
    ctor.prototype = newProto;
    return ctor;
}


module.exports = inherit;
inherit._inherit = inherit;

});
$_mod.remap("/marko$4.19.8/dist/runtime/nextTick", "/marko$4.19.8/dist/runtime/nextTick-browser");
$_mod.def("/marko$4.19.8/dist/runtime/nextTick-browser", function(require, exports, module, __filename, __dirname) { /* globals window */

var win = window;
var setImmediate = win.setImmediate;

if (!setImmediate) {
  if (win.postMessage) {
    var queue = [];
    var messageName = "si";
    win.addEventListener("message", function (event) {
      var source = event.source;
      if (source == win || !source && event.data === messageName) {
        event.stopPropagation();
        if (queue.length > 0) {
          var fn = queue.shift();
          fn();
        }
      }
    }, true);

    setImmediate = function (fn) {
      queue.push(fn);
      win.postMessage(messageName, "*");
    };
  } else {
    setImmediate = setTimeout;
  }
}

module.exports = setImmediate;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/update-manager", function(require, exports, module, __filename, __dirname) { "use strict";

var updatesScheduled = false;
var batchStack = []; // A stack of batched updates
var unbatchedQueue = []; // Used for scheduled batched updates

var nextTick = require('/marko$4.19.8/dist/runtime/nextTick-browser'/*"../nextTick"*/);

/**
 * This function is called when we schedule the update of "unbatched"
 * updates to components.
 */
function updateUnbatchedComponents() {
  if (unbatchedQueue.length) {
    try {
      updateComponents(unbatchedQueue);
    } finally {
      // Reset the flag now that this scheduled batch update
      // is complete so that we can later schedule another
      // batched update if needed
      updatesScheduled = false;
    }
  }
}

function scheduleUpdates() {
  if (updatesScheduled) {
    // We have already scheduled a batched update for the
    // process.nextTick so nothing to do
    return;
  }

  updatesScheduled = true;

  nextTick(updateUnbatchedComponents);
}

function updateComponents(queue) {
  // Loop over the components in the queue and update them.
  // NOTE: It is okay if the queue grows during the iteration
  //       since we will still get to them at the end
  for (var i = 0; i < queue.length; i++) {
    var component = queue[i];
    component._y_(); // Do the actual component update
  }

  // Clear out the queue by setting the length to zero
  queue.length = 0;
}

function batchUpdate(func) {
  // If the batched update stack is empty then this
  // is the outer batched update. After the outer
  // batched update completes we invoke the "afterUpdate"
  // event listeners.
  var batch = {
    aF_: null
  };

  batchStack.push(batch);

  try {
    func();
  } finally {
    try {
      // Update all of the components that where queued up
      // in this batch (if any)
      if (batch.aF_) {
        updateComponents(batch.aF_);
      }
    } finally {
      // Now that we have completed the update of all the components
      // in this batch we need to remove it off the top of the stack
      batchStack.length--;
    }
  }
}

function queueComponentUpdate(component) {
  var batchStackLen = batchStack.length;

  if (batchStackLen) {
    // When a batch update is started we push a new batch on to a stack.
    // If the stack has a non-zero length then we know that a batch has
    // been started so we can just queue the component on the top batch. When
    // the batch is ended this component will be updated.
    var batch = batchStack[batchStackLen - 1];

    // We default the batch queue to null to avoid creating an Array instance
    // unnecessarily. If it is null then we create a new Array, otherwise
    // we push it onto the existing Array queue
    if (batch.aF_) {
      batch.aF_.push(component);
    } else {
      batch.aF_ = [component];
    }
  } else {
    // We are not within a batched update. We need to schedule a batch update
    // for the process.nextTick (if that hasn't been done already) and we will
    // add the component to the unbatched queued
    scheduleUpdates();
    unbatchedQueue.push(component);
  }
}

exports._l_ = queueComponentUpdate;
exports._r_ = batchUpdate;
});
$_mod.main("/marko$4.19.8/dist/runtime/vdom/morphdom", "");
$_mod.def("/marko$4.19.8/dist/runtime/vdom/morphdom/specialElHandlers", function(require, exports, module, __filename, __dirname) { function syncBooleanAttrProp(fromEl, toEl, name) {
  if (fromEl[name] !== toEl[name]) {
    fromEl[name] = toEl[name];
    if (fromEl[name]) {
      fromEl.setAttribute(name, "");
    } else {
      fromEl.removeAttribute(name, "");
    }
  }
}

function forEachOption(el, fn, i) {
  var curChild = el.a_;

  while (curChild) {
    if (curChild.bG_ === "option") {
      fn(curChild, ++i);
    } else {
      i = forEachOption(curChild, fn, i);
    }

    curChild = curChild.b_;
  }

  return i;
}

// We use a JavaScript class to benefit from fast property lookup
function SpecialElHandlers() {}
SpecialElHandlers.prototype = {
  /**
   * Needed for IE. Apparently IE doesn't think that "selected" is an
   * attribute when reading over the attributes using selectEl.attributes
   */
  option: function (fromEl, toEl) {
    syncBooleanAttrProp(fromEl, toEl, "selected");
  },
  button: function (fromEl, toEl) {
    syncBooleanAttrProp(fromEl, toEl, "disabled");
  },
  /**
   * The "value" attribute is special for the <input> element since it sets
   * the initial value. Changing the "value" attribute without changing the
   * "value" property will have no effect since it is only used to the set the
   * initial value.  Similar for the "checked" attribute, and "disabled".
   */
  input: function (fromEl, toEl) {
    syncBooleanAttrProp(fromEl, toEl, "checked");
    syncBooleanAttrProp(fromEl, toEl, "disabled");

    if (fromEl.value != toEl.t_) {
      fromEl.value = toEl.t_;
    }

    if (fromEl.hasAttribute("value") && !toEl.bK_("value")) {
      fromEl.removeAttribute("value");
    }
  },

  textarea: function (fromEl, toEl) {
    if (toEl.bS_) {
      return;
    }

    var newValue = toEl.t_;
    if (fromEl.value != newValue) {
      fromEl.value = newValue;
    }

    var firstChild = fromEl.firstChild;
    if (firstChild) {
      // Needed for IE. Apparently IE sets the placeholder as the
      // node value and vise versa. This ignores an empty update.
      var oldValue = firstChild.nodeValue;

      if (oldValue == newValue || !newValue && oldValue == fromEl.placeholder) {
        return;
      }

      firstChild.nodeValue = newValue;
    }
  },
  select: function (fromEl, toEl) {
    if (!toEl.bK_("multiple")) {
      var selected = 0;
      forEachOption(toEl, function (option, i) {
        if (option.bK_("selected")) {
          selected = i;
        }
      }, -1);

      if (fromEl.selectedIndex !== selected) {
        fromEl.selectedIndex = selected;
      }
    }
  }
};

module.exports = new SpecialElHandlers();
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VNode", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */
function VNode() {}

VNode.prototype = {
  bw_: function (finalChildCount, ownerComponent) {
    this.bO_ = finalChildCount;
    this.bP_ = 0;
    this.bE_ = null;
    this.bQ_ = null;
    this.bB_ = null;
    this.bC_ = null;
    this.aG_ = ownerComponent;
  },

  get a_() {
    var firstChild = this.bE_;

    if (firstChild && firstChild.bD_) {
      var nestedFirstChild = firstChild.a_;
      // The first child is a DocumentFragment node.
      // If the DocumentFragment node has a first child then we will return that.
      // Otherwise, the DocumentFragment node is not *really* the first child and
      // we need to skip to its next sibling
      return nestedFirstChild || firstChild.b_;
    }

    return firstChild;
  },

  get b_() {
    var nextSibling = this.bC_;

    if (nextSibling) {
      if (nextSibling.bD_) {
        var firstChild = nextSibling.a_;
        return firstChild || nextSibling.b_;
      }
    } else {
      var parentNode = this.bB_;
      if (parentNode && parentNode.bD_) {
        return parentNode.b_;
      }
    }

    return nextSibling;
  },

  bp_: function (child) {
    this.bP_++;

    if (this.bG_ === "textarea") {
      if (child.bR_) {
        var childValue = child.bx_;
        this.bH_ = (this.bH_ || "") + childValue;
      } else if (child.bA_) {
        this.bS_ = true;
      } else {
        throw TypeError();
      }
    } else {
      var lastChild = this.bQ_;

      child.bB_ = this;

      if (lastChild) {
        lastChild.bC_ = child;
      } else {
        this.bE_ = child;
      }

      this.bQ_ = child;
    }

    return child;
  },

  bJ_: function finishChild() {
    if (this.bP_ === this.bO_ && this.bB_) {
      return this.bB_.bJ_();
    } else {
      return this;
    }
  }

  // ,toJSON: function() {
  //     var clone = Object.assign({
  //         nodeType: this.nodeType
  //     }, this);
  //
  //     for (var k in clone) {
  //         if (k.startsWith('_')) {
  //             delete clone[k];
  //         }
  //     }
  //     delete clone._nextSibling;
  //     delete clone._lastChild;
  //     delete clone.parentNode;
  //     return clone;
  // }
};

module.exports = VNode;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VComment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComment(value, ownerComponent) {
  this.bw_(-1 /* no children */, ownerComponent);
  this.bx_ = value;
}

VComment.prototype = {
  by_: 8,

  bv_: function (doc) {
    var nodeValue = this.bx_;
    return doc.createComment(nodeValue);
  },

  __: function () {
    return new VComment(this.bx_);
  }
};

inherit(VComment, VNode);

module.exports = VComment;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VDocumentFragment", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function VDocumentFragmentClone(other) {
  extend(this, other);
  this.bB_ = null;
  this.bC_ = null;
}

function VDocumentFragment(out) {
  this.bw_(null /* childCount */);
  this.B_ = out;
}

VDocumentFragment.prototype = {
  by_: 11,

  bD_: true,

  __: function () {
    return new VDocumentFragmentClone(this);
  },

  bv_: function (doc) {
    return doc.createDocumentFragment();
  }
};

inherit(VDocumentFragment, VNode);

VDocumentFragmentClone.prototype = VDocumentFragment.prototype;

module.exports = VDocumentFragment;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VElement", function(require, exports, module, __filename, __dirname) { /* jshint newcap:false */

var complain;
var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"../components/dom-data"*/);
var vElementByDOMNode = domData.ad_;
var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var ATTR_XLINK_HREF = "xlink:href";
var xmlnsRegExp = /^xmlns(:|$)/;
var NS_XLINK = "http://www.w3.org/1999/xlink";
var NS_HTML = "http://www.w3.org/1999/xhtml";
var NS_MATH = "http://www.w3.org/1998/Math/MathML";
var NS_SVG = "http://www.w3.org/2000/svg";
var DEFAULT_NS = {
  svg: NS_SVG,
  math: NS_MATH
};

var FLAG_SIMPLE_ATTRS = 1;
var FLAG_CUSTOM_ELEMENT = 2;

var defineProperty = Object.defineProperty;

var ATTR_HREF = "href";
var EMPTY_OBJECT = Object.freeze({});

function convertAttrValue(type, value) {
  if (value === true) {
    return "";
  } else if (type == "object") {
    switch (value.toString) {
      case Object.prototype.toString:
      case Array.prototype.toString:
        return JSON.stringify(value);
        // eslint-disable-next-line no-constant-condition

      case RegExp.prototype.toString:
        return value.source;
    }
  }

  return value + "";
}

function assign(a, b) {
  for (var key in b) {
    if (b.hasOwnProperty(key)) {
      a[key] = b[key];
    }
  }
}

function setAttribute(el, namespaceURI, name, value) {
  if (namespaceURI === null) {
    el.setAttribute(name, value);
  } else {
    el.setAttributeNS(namespaceURI, name, value);
  }
}

function removeAttribute(el, namespaceURI, name) {
  if (namespaceURI === null) {
    el.removeAttribute(name);
  } else {
    el.removeAttributeNS(namespaceURI, name);
  }
}

function VElementClone(other) {
  this.bE_ = other.bE_;
  this.bB_ = null;
  this.bC_ = null;

  this.bz_ = other.bz_;
  this.bF_ = other.bF_;
  this.aH_ = other.aH_;
  this.bG_ = other.bG_;
  this._G_ = other._G_;
  this.bH_ = other.bH_;
  this.bI_ = other.bI_;
}

function VElement(tagName, attrs, key, ownerComponent, childCount, flags, props) {
  this.bw_(childCount, ownerComponent);

  var constId;

  if (props) {
    constId = props.i;
  }

  this.bz_ = key;
  this._G_ = flags || 0;
  this.bF_ = attrs || EMPTY_OBJECT;
  this.aH_ = props || EMPTY_OBJECT;
  this.bG_ = tagName;
  this.bH_ = null;
  this.bI_ = constId;
}

VElement.prototype = {
  by_: 1,

  __: function () {
    return new VElementClone(this);
  },

  /**
   * Shorthand method for creating and appending an HTML element
   *
   * @param  {String} tagName    The tag name (e.g. "div")
   * @param  {int|null} attrCount  The number of attributes (or `null` if not known)
   * @param  {int|null} childCount The number of child nodes (or `null` if not known)
   */
  e: function (tagName, attrs, key, ownerComponent, childCount, flags, props) {
    var child = this.bp_(new VElement(tagName, attrs, key, ownerComponent, childCount, flags, props));

    if (childCount === 0) {
      return this.bJ_();
    } else {
      return child;
    }
  },

  /**
   * Shorthand method for creating and appending a static node. The provided node is automatically cloned
   * using a shallow clone since it will be mutated as a result of setting `nextSibling` and `parentNode`.
   *
   * @param  {String} value The value for the new Comment node
   */
  n: function (node, ownerComponent) {
    node = node.__();
    node.aG_ = ownerComponent;
    this.bp_(node);
    return this.bJ_();
  },

  bv_: function (doc, parentNamespaceURI) {
    var tagName = this.bG_;
    var attributes = this.bF_;
    var namespaceURI = DEFAULT_NS[tagName] || parentNamespaceURI || NS_HTML;

    var flags = this._G_;
    var el = doc.createElementNS(namespaceURI, tagName);

    if (flags & FLAG_CUSTOM_ELEMENT) {
      assign(el, attributes);
    } else {
      for (var attrName in attributes) {
        var attrValue = attributes[attrName];

        if (attrValue !== false && attrValue != null) {
          var type = typeof attrValue;

          if (type !== "string") {
            // Special attributes aren't copied to the real DOM. They are only
            // kept in the virtual attributes map
            attrValue = convertAttrValue(type, attrValue);
          }

          if (attrName == ATTR_XLINK_HREF) {
            setAttribute(el, NS_XLINK, ATTR_HREF, attrValue);
          } else {
            el.setAttribute(attrName, attrValue);
          }
        }
      }

      if (tagName === "textarea") {
        el.value = this.t_;
      }
    }

    vElementByDOMNode.set(el, this);

    return el;
  },

  bK_: function (name) {
    // We don't care about the namespaces since the there
    // is no chance that attributes with the same name will have
    // different namespaces
    var value = this.bF_[name];
    return value != null && value !== false;
  }
};

inherit(VElement, VNode);

var proto = VElementClone.prototype = VElement.prototype;

["checked", "selected", "disabled"].forEach(function (name) {
  defineProperty(proto, name, {
    get: function () {
      var value = this.bF_[name];
      return value !== false && value != null;
    }
  });
});

defineProperty(proto, "t_", {
  get: function () {
    var value = this.bH_;
    if (value == null) {
      value = this.bF_.value;
    }
    return value != null && value !== false ? value + "" : this.bF_.type === "checkbox" || this.bF_.type === "radio" ? "on" : "";
  }
});

VElement.bL_ = function (attrs) {
  // By default this static method is a no-op, but if there are any
  // compiled components that have "no-update" attributes then
  // `preserve-attrs.js` will be imported and this method will be replaced
  // with a method that actually does something
  return attrs;
};

function virtualizeElement(node, virtualizeChildNodes, ownerComponent) {
  var attributes = node.attributes;
  var attrCount = attributes.length;

  var attrs;

  if (attrCount) {
    attrs = {};
    for (var i = 0; i < attrCount; i++) {
      var attr = attributes[i];
      var attrName = attr.name;
      if (!xmlnsRegExp.test(attrName) && attrName !== "data-marko") {
        var attrNamespaceURI = attr.namespaceURI;
        if (attrNamespaceURI === NS_XLINK) {
          attrs[ATTR_XLINK_HREF] = attr.value;
        } else {
          attrs[attrName] = attr.value;
        }
      }
    }
  }

  var tagName = node.nodeName;

  if (node.namespaceURI === NS_HTML) {
    tagName = tagName.toLowerCase();
  }

  var vdomEl = new VElement(tagName, attrs, null /*key*/
  , ownerComponent, 0 /*child count*/
  , 0 /*flags*/
  , null /*props*/
  );

  if (vdomEl.bG_ === "textarea") {
    vdomEl.bH_ = node.value;
  } else if (virtualizeChildNodes) {
    virtualizeChildNodes(node, vdomEl, ownerComponent);
  }

  return vdomEl;
}

VElement.bM_ = virtualizeElement;

VElement.bN_ = function (fromEl, vFromEl, toEl) {
  var removePreservedAttributes = VElement.bL_;

  var fromFlags = vFromEl._G_;
  var toFlags = toEl._G_;

  vElementByDOMNode.set(fromEl, toEl);

  var attrs = toEl.bF_;
  var props = toEl.aH_;

  if (toFlags & FLAG_CUSTOM_ELEMENT) {
    return assign(fromEl, attrs);
  }

  var attrName;

  // We use expando properties to associate the previous HTML
  // attributes provided as part of the VDOM node with the
  // real VElement DOM node. When diffing attributes,
  // we only use our internal representation of the attributes.
  // When diffing for the first time it's possible that the
  // real VElement node will not have the expando property
  // so we build the attribute map from the expando property

  var oldAttrs = vFromEl.bF_;

  if (oldAttrs) {
    if (oldAttrs === attrs) {
      // For constant attributes the same object will be provided
      // every render and we can use that to our advantage to
      // not waste time diffing a constant, immutable attribute
      // map.
      return;
    } else {
      oldAttrs = removePreservedAttributes(oldAttrs, props);
    }
  }

  var attrValue;

  if (toFlags & FLAG_SIMPLE_ATTRS && fromFlags & FLAG_SIMPLE_ATTRS) {
    if (oldAttrs["class"] !== (attrValue = attrs["class"])) {
      fromEl.className = attrValue;
    }
    if (oldAttrs.id !== (attrValue = attrs.id)) {
      fromEl.id = attrValue;
    }
    if (oldAttrs.style !== (attrValue = attrs.style)) {
      fromEl.style.cssText = attrValue;
    }
    return;
  }

  // In some cases we only want to set an attribute value for the first
  // render or we don't want certain attributes to be touched. To support
  // that use case we delete out all of the preserved attributes
  // so it's as if they never existed.
  attrs = removePreservedAttributes(attrs, props, true);

  var namespaceURI;

  // Loop over all of the attributes in the attribute map and compare
  // them to the value in the old map. However, if the value is
  // null/undefined/false then we want to remove the attribute
  for (attrName in attrs) {
    attrValue = attrs[attrName];
    namespaceURI = null;

    if (attrName === ATTR_XLINK_HREF) {
      namespaceURI = NS_XLINK;
      attrName = ATTR_HREF;
    }

    if (attrValue == null || attrValue === false) {
      removeAttribute(fromEl, namespaceURI, attrName);
    } else if (oldAttrs[attrName] !== attrValue) {
      var type = typeof attrValue;

      if (type !== "string") {
        attrValue = convertAttrValue(type, attrValue);
      }

      setAttribute(fromEl, namespaceURI, attrName, attrValue);
    }
  }

  // If there are any old attributes that are not in the new set of attributes
  // then we need to remove those attributes from the target node
  //
  // NOTE: We can skip this if the the element is keyed because if the element
  //       is keyed then we know we already processed all of the attributes for
  //       both the target and original element since target VElement nodes will
  //       have all attributes declared. However, we can only skip if the node
  //       was not a virtualized node (i.e., a node that was not rendered by a
  //       Marko template, but rather a node that was created from an HTML
  //       string or a real DOM node).
  if (toEl.bz_ === null) {
    for (attrName in oldAttrs) {
      if (!(attrName in attrs)) {
        if (attrName === ATTR_XLINK_HREF) {
          fromEl.removeAttributeNS(ATTR_XLINK_HREF, ATTR_HREF);
        } else {
          fromEl.removeAttribute(attrName);
        }
      }
    }
  }
};

module.exports = VElement;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VText", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VText(value, ownerComponent) {
  this.bw_(-1 /* no children */, ownerComponent);
  this.bx_ = value;
}

VText.prototype = {
  bR_: true,

  by_: 3,

  bv_: function (doc) {
    return doc.createTextNode(this.bx_);
  },

  __: function () {
    return new VText(this.bx_);
  }
};

inherit(VText, VNode);

module.exports = VText;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VComponent", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

function VComponent(component, key, ownerComponent, preserve) {
  this.bw_(null /* childCount */, ownerComponent);
  this.bz_ = key;
  this.m_ = component;
  this.bA_ = preserve;
}

VComponent.prototype = {
  by_: 2
};

inherit(VComponent, VNode);

module.exports = VComponent;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/VFragment", function(require, exports, module, __filename, __dirname) { var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"../components/dom-data"*/);
var keysByDOMNode = domData.af_;
var vElementByDOMNode = domData.ad_;
var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var createFragmentNode = require('/marko$4.19.8/dist/runtime/vdom/morphdom/fragment'/*"./morphdom/fragment"*/).am_;

function VFragment(key, ownerComponent, preserve) {
  this.bw_(null /* childCount */, ownerComponent);
  this.bz_ = key;
  this.bA_ = preserve;
}

VFragment.prototype = {
  by_: 12,
  bv_: function () {
    var fragment = createFragmentNode();
    keysByDOMNode.set(fragment, this.bz_);
    vElementByDOMNode.set(fragment, this);
    return fragment;
  }
};

inherit(VFragment, VNode);

module.exports = VFragment;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/vdom", function(require, exports, module, __filename, __dirname) { var VNode = require('/marko$4.19.8/dist/runtime/vdom/VNode'/*"./VNode"*/);
var VComment = require('/marko$4.19.8/dist/runtime/vdom/VComment'/*"./VComment"*/);
var VDocumentFragment = require('/marko$4.19.8/dist/runtime/vdom/VDocumentFragment'/*"./VDocumentFragment"*/);
var VElement = require('/marko$4.19.8/dist/runtime/vdom/VElement'/*"./VElement"*/);
var VText = require('/marko$4.19.8/dist/runtime/vdom/VText'/*"./VText"*/);
var VComponent = require('/marko$4.19.8/dist/runtime/vdom/VComponent'/*"./VComponent"*/);
var VFragment = require('/marko$4.19.8/dist/runtime/vdom/VFragment'/*"./VFragment"*/);

var defaultDocument = typeof document != "undefined" && document;
var specialHtmlRegexp = /[&<]/;

function virtualizeChildNodes(node, vdomParent, ownerComponent) {
  var curChild = node.firstChild;
  while (curChild) {
    vdomParent.bp_(virtualize(curChild, ownerComponent));
    curChild = curChild.nextSibling;
  }
}

function virtualize(node, ownerComponent) {
  switch (node.nodeType) {
    case 1:
      return VElement.bM_(node, virtualizeChildNodes, ownerComponent);
    case 3:
      return new VText(node.nodeValue, ownerComponent);
    case 8:
      return new VComment(node.nodeValue, ownerComponent);
    case 11:
      var vdomDocFragment = new VDocumentFragment();
      virtualizeChildNodes(node, vdomDocFragment, ownerComponent);
      return vdomDocFragment;
  }
}

function virtualizeHTML(html, doc, ownerComponent) {
  if (!specialHtmlRegexp.test(html)) {
    return new VText(html, ownerComponent);
  }

  var container = doc.createElement("body");
  container.innerHTML = html;
  var vdomFragment = new VDocumentFragment();

  var curChild = container.firstChild;
  while (curChild) {
    vdomFragment.bp_(virtualize(curChild, ownerComponent));
    curChild = curChild.nextSibling;
  }

  return vdomFragment;
}

var Node_prototype = VNode.prototype;

/**
 * Shorthand method for creating and appending a Text node with a given value
 * @param  {String} value The text value for the new Text node
 */
Node_prototype.t = function (value) {
  var type = typeof value;
  var vdomNode;

  if (type !== "string") {
    if (value == null) {
      value = "";
    } else if (type === "object") {
      if (value.toHTML) {
        vdomNode = virtualizeHTML(value.toHTML(), document);
      }
    }
  }

  this.bp_(vdomNode || new VText(value.toString()));
  return this.bJ_();
};

/**
 * Shorthand method for creating and appending a Comment node with a given value
 * @param  {String} value The value for the new Comment node
 */
Node_prototype.c = function (value) {
  this.bp_(new VComment(value));
  return this.bJ_();
};

Node_prototype.bt_ = function () {
  return this.bp_(new VDocumentFragment());
};

exports.aZ_ = VComment;
exports.aY_ = VDocumentFragment;
exports.aX_ = VElement;
exports.b__ = VText;
exports.ba_ = VComponent;
exports.bb_ = VFragment;
exports.bM_ = virtualize;
exports.bc_ = virtualizeHTML;
exports.bd_ = defaultDocument;
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/morphdom/index", function(require, exports, module, __filename, __dirname) { "use strict";

var specialElHandlers = require('/marko$4.19.8/dist/runtime/vdom/morphdom/specialElHandlers'/*"./specialElHandlers"*/);
var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"../../components/util"*/);
var existingComponentLookup = componentsUtil.F_;
var destroyNodeRecursive = componentsUtil.H_;
var addComponentRootToKeyedElements = componentsUtil.an_;
var normalizeComponentKey = componentsUtil.aJ_;
var VElement = require('/marko$4.19.8/dist/runtime/vdom/vdom'/*"../vdom"*/).aX_;
var virtualizeElement = VElement.bM_;
var morphAttrs = VElement.bN_;
var eventDelegation = require('/marko$4.19.8/dist/runtime/components/event-delegation'/*"../../components/event-delegation"*/);
var fragment = require('/marko$4.19.8/dist/runtime/vdom/morphdom/fragment'/*"./fragment"*/);
var helpers = require('/marko$4.19.8/dist/runtime/vdom/morphdom/helpers'/*"./helpers"*/);
var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"../../components/dom-data"*/);
var keysByDOMNode = domData.af_;
var componentByDOMNode = domData.I_;
var vElementByDOMNode = domData.ad_;
var detachedByDOMNode = domData.ae_;

var insertBefore = helpers.aL_;
var insertAfter = helpers.aM_;
var nextSibling = helpers.b_;
var firstChild = helpers.a_;
var removeChild = helpers.aN_;
var createFragmentNode = fragment.am_;
var beginFragmentNode = fragment.bU_;

var ELEMENT_NODE = 1;
var TEXT_NODE = 3;
var COMMENT_NODE = 8;
var COMPONENT_NODE = 2;
var FRAGMENT_NODE = 12;
var DOCTYPE_NODE = 10;

// var FLAG_SIMPLE_ATTRS = 1;
// var FLAG_CUSTOM_ELEMENT = 2;

function isAutoKey(key) {
  return !/^@/.test(key);
}

function compareNodeNames(fromEl, toEl) {
  return fromEl.bG_ === toEl.bG_;
}

function caseInsensitiveCompare(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

function onNodeAdded(node, componentsContext) {
  if (node.nodeType === 1) {
    eventDelegation.aa_(node, componentsContext);
  }
}

function morphdom(fromNode, toNode, doc, componentsContext) {
  var globalComponentsContext;
  var isHydrate = false;
  var keySequences = {};

  if (componentsContext) {
    globalComponentsContext = componentsContext.j_;
    isHydrate = globalComponentsContext.k_;
  }

  function insertVirtualNodeBefore(vNode, key, referenceEl, parentEl, ownerComponent, parentComponent) {
    var realNode = vNode.bv_(doc, parentEl.namespaceURI);
    insertBefore(realNode, referenceEl, parentEl);

    if (vNode.by_ === ELEMENT_NODE || vNode.by_ === FRAGMENT_NODE) {
      if (key) {
        keysByDOMNode.set(realNode, key);
        (isAutoKey(key) ? parentComponent : ownerComponent).o_[key] = realNode;
      }

      morphChildren(realNode, vNode, parentComponent);
    }

    onNodeAdded(realNode, componentsContext);
  }

  function insertVirtualComponentBefore(vComponent, referenceNode, referenceNodeParentEl, component, key, ownerComponent, parentComponent) {
    var rootNode = component.N_ = insertBefore(createFragmentNode(), referenceNode, referenceNodeParentEl);
    componentByDOMNode.set(rootNode, component);

    if (key && ownerComponent) {
      key = normalizeComponentKey(key, parentComponent.id);
      addComponentRootToKeyedElements(ownerComponent.o_, key, rootNode, component.id);
      keysByDOMNode.set(rootNode, key);
    }

    morphComponent(component, vComponent);
  }

  function morphComponent(component, vComponent) {
    morphChildren(component.N_, vComponent, component);
  }

  var detachedNodes = [];

  function detachNode(node, parentNode, ownerComponent) {
    if (node.nodeType === ELEMENT_NODE || node.nodeType === FRAGMENT_NODE) {
      detachedNodes.push(node);
      detachedByDOMNode.set(node, ownerComponent || true);
    } else {
      destroyNodeRecursive(node);
      removeChild(node);
    }
  }

  function destroyComponent(component) {
    component.destroy();
  }

  function morphChildren(fromNode, toNode, parentComponent) {
    var curFromNodeChild = firstChild(fromNode);
    var curToNodeChild = toNode.a_;

    var curToNodeKey;
    var curFromNodeKey;
    var curToNodeType;

    var fromNextSibling;
    var toNextSibling;
    var matchingFromEl;
    var matchingFromComponent;
    var curVFromNodeChild;
    var fromComponent;

    outer: while (curToNodeChild) {
      toNextSibling = curToNodeChild.b_;
      curToNodeType = curToNodeChild.by_;
      curToNodeKey = curToNodeChild.bz_;

      // Skip <!doctype>
      if (curFromNodeChild && curFromNodeChild.nodeType === DOCTYPE_NODE) {
        curFromNodeChild = nextSibling(curFromNodeChild);
      }

      var ownerComponent = curToNodeChild.aG_ || parentComponent;
      var referenceComponent;

      if (curToNodeType === COMPONENT_NODE) {
        var component = curToNodeChild.m_;
        if ((matchingFromComponent = existingComponentLookup[component.id]) === undefined) {
          if (isHydrate === true) {
            var rootNode = beginFragmentNode(curFromNodeChild, fromNode);
            component.N_ = rootNode;
            componentByDOMNode.set(rootNode, component);

            if (ownerComponent && curToNodeKey) {
              curToNodeKey = normalizeComponentKey(curToNodeKey, parentComponent.id);
              addComponentRootToKeyedElements(ownerComponent.o_, curToNodeKey, rootNode, component.id);

              keysByDOMNode.set(rootNode, curToNodeKey);
            }

            morphComponent(component, curToNodeChild);

            curFromNodeChild = nextSibling(rootNode);
          } else {
            insertVirtualComponentBefore(curToNodeChild, curFromNodeChild, fromNode, component, curToNodeKey, ownerComponent, parentComponent);
          }
        } else {
          if (matchingFromComponent.N_ !== curFromNodeChild) {
            if (curFromNodeChild && (fromComponent = componentByDOMNode.get(curFromNodeChild)) && globalComponentsContext._S_[fromComponent.id] === undefined) {
              // The component associated with the current real DOM node was not rendered
              // so we should just remove it out of the real DOM by destroying it
              curFromNodeChild = nextSibling(fromComponent.N_);
              destroyComponent(fromComponent);
              continue;
            }

            // We need to move the existing component into
            // the correct location
            insertBefore(matchingFromComponent.N_, curFromNodeChild, fromNode);
          } else {
            curFromNodeChild = curFromNodeChild && nextSibling(curFromNodeChild);
          }

          if (!curToNodeChild.bA_) {
            morphComponent(component, curToNodeChild);
          }
        }

        curToNodeChild = toNextSibling;
        continue;
      } else if (curToNodeKey) {
        curVFromNodeChild = undefined;
        curFromNodeKey = undefined;
        var curToNodeKeyOriginal = curToNodeKey;

        if (isAutoKey(curToNodeKey)) {
          if (ownerComponent !== parentComponent) {
            curToNodeKey += ":" + ownerComponent.id;
          }
          referenceComponent = parentComponent;
        } else {
          referenceComponent = ownerComponent;
        }

        var keySequence = keySequences[referenceComponent.id] || (keySequences[referenceComponent.id] = globalComponentsContext._T_());

        // We have a keyed element. This is the fast path for matching
        // up elements
        curToNodeKey = keySequence._I_(curToNodeKey);

        if (curFromNodeChild) {
          curFromNodeKey = keysByDOMNode.get(curFromNodeChild);
          curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
          fromNextSibling = nextSibling(curFromNodeChild);
        }

        if (curFromNodeKey === curToNodeKey) {
          // Elements line up. Now we just have to make sure they are compatible
          if (!curToNodeChild.bA_) {
            // We just skip over the fromNode if it is preserved

            if (compareNodeNames(curToNodeChild, curVFromNodeChild)) {
              morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
            } else {
              // Remove the old node
              detachNode(curFromNodeChild, fromNode, ownerComponent);

              // Incompatible nodes. Just move the target VNode into the DOM at this position
              insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
            }
          }
        } else {
          if ((matchingFromEl = referenceComponent.o_[curToNodeKey]) === undefined) {
            if (isHydrate === true && curFromNodeChild) {
              if (curFromNodeChild.nodeType === ELEMENT_NODE && caseInsensitiveCompare(curFromNodeChild.nodeName, curToNodeChild.bG_ || "")) {
                curVFromNodeChild = virtualizeElement(curFromNodeChild);
                curVFromNodeChild.bG_ = curToNodeChild.bG_;
                keysByDOMNode.set(curFromNodeChild, curToNodeKey);
                morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
                curToNodeChild = toNextSibling;
                curFromNodeChild = fromNextSibling;
                continue;
              } else if (curToNodeChild.by_ === FRAGMENT_NODE && curFromNodeChild.nodeType === COMMENT_NODE) {
                var content = curFromNodeChild.nodeValue;
                if (content == "F#" + curToNodeKeyOriginal) {
                  var endNode = curFromNodeChild.nextSibling;
                  var depth = 0;
                  var nodeValue;

                  // eslint-disable-next-line no-constant-condition
                  while (true) {
                    if (endNode.nodeType === COMMENT_NODE) {
                      nodeValue = endNode.nodeValue;
                      if (nodeValue === "F/") {
                        if (depth === 0) {
                          break;
                        } else {
                          depth--;
                        }
                      } else if (nodeValue.indexOf("F#") === 0) {
                        depth++;
                      }
                    }
                    endNode = endNode.nextSibling;
                  }

                  var fragment = createFragmentNode(curFromNodeChild, endNode.nextSibling, fromNode);
                  keysByDOMNode.set(fragment, curToNodeKey);
                  vElementByDOMNode.set(fragment, curToNodeChild);
                  referenceComponent.o_[curToNodeKey] = fragment;
                  removeChild(curFromNodeChild);
                  removeChild(endNode);

                  if (!curToNodeChild.bA_) {
                    morphChildren(fragment, curToNodeChild, parentComponent);
                  }

                  curToNodeChild = toNextSibling;
                  curFromNodeChild = fragment.nextSibling;
                  continue;
                }
              }
            }

            insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
            fromNextSibling = curFromNodeChild;
          } else {
            if (detachedByDOMNode.get(matchingFromEl) !== undefined) {
              detachedByDOMNode.set(matchingFromEl, undefined);
            }

            if (!curToNodeChild.bA_) {
              curVFromNodeChild = vElementByDOMNode.get(matchingFromEl);

              if (compareNodeNames(curVFromNodeChild, curToNodeChild)) {
                if (fromNextSibling === matchingFromEl) {
                  // Single element removal:
                  // A <-> A
                  // B <-> C <-- We are here
                  // C     D
                  // D
                  //
                  // Single element swap:
                  // A <-> A
                  // B <-> C <-- We are here
                  // C     B

                  if (toNextSibling && toNextSibling.bz_ === curFromNodeKey) {
                    // Single element swap

                    // We want to stay on the current real DOM node
                    fromNextSibling = curFromNodeChild;

                    // But move the matching element into place
                    insertBefore(matchingFromEl, curFromNodeChild, fromNode);
                  } else {
                    // Single element removal

                    // We need to remove the current real DOM node
                    // and the matching real DOM node will fall into
                    // place. We will continue diffing with next sibling
                    // after the real DOM node that just fell into place
                    fromNextSibling = nextSibling(fromNextSibling);

                    if (curFromNodeChild) {
                      detachNode(curFromNodeChild, fromNode, ownerComponent);
                    }
                  }
                } else {
                  // A <-> A
                  // B <-> D <-- We are here
                  // C
                  // D

                  // We need to move the matching node into place
                  insertAfter(matchingFromEl, curFromNodeChild, fromNode);

                  if (curFromNodeChild) {
                    detachNode(curFromNodeChild, fromNode, ownerComponent);
                  }
                }

                morphEl(matchingFromEl, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
              } else {
                insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);
                detachNode(matchingFromEl, fromNode, ownerComponent);
              }
            } else {
              // preserve the node
              // but still we need to diff the current from node
              insertBefore(matchingFromEl, curFromNodeChild, fromNode);
              fromNextSibling = curFromNodeChild;
            }
          }
        }

        curToNodeChild = toNextSibling;
        curFromNodeChild = fromNextSibling;
        continue;
      }

      // The know the target node is not a VComponent node and we know
      // it is also not a preserve node. Let's now match up the HTML
      // element, text node, comment, etc.
      while (curFromNodeChild) {
        fromNextSibling = nextSibling(curFromNodeChild);

        if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
          // The current "to" element is not associated with a component,
          // but the current "from" element is associated with a component

          // Even if we destroy the current component in the original
          // DOM or not, we still need to skip over it since it is
          // not compatible with the current "to" node
          curFromNodeChild = fromNextSibling;

          if (!globalComponentsContext._S_[fromComponent.id]) {
            destroyComponent(fromComponent);
          }

          continue; // Move to the next "from" node
        }

        var curFromNodeType = curFromNodeChild.nodeType;

        var isCompatible = undefined;

        if (curFromNodeType === curToNodeType) {
          if (curFromNodeType === ELEMENT_NODE) {
            // Both nodes being compared are Element nodes
            curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);
            if (curVFromNodeChild === undefined) {
              if (isHydrate === true) {
                curVFromNodeChild = virtualizeElement(curFromNodeChild);

                if (caseInsensitiveCompare(curVFromNodeChild.bG_, curToNodeChild.bG_)) {
                  curVFromNodeChild.bG_ = curToNodeChild.bG_;
                }
              } else {
                // Skip over nodes that don't look like ours...
                curFromNodeChild = fromNextSibling;
                continue;
              }
            } else if (curFromNodeKey = curVFromNodeChild.bz_) {
              // We have a keyed element here but our target VDOM node
              // is not keyed so this not doesn't belong
              isCompatible = false;
            }

            isCompatible = isCompatible !== false && compareNodeNames(curVFromNodeChild, curToNodeChild) === true;

            if (isCompatible === true) {
              // We found compatible DOM elements so transform
              // the current "from" node to match the current
              // target DOM node.
              morphEl(curFromNodeChild, curVFromNodeChild, curToNodeChild, curToNodeKey, ownerComponent, parentComponent);
            }
          } else if (curFromNodeType === TEXT_NODE || curFromNodeType === COMMENT_NODE) {
            // Both nodes being compared are Text or Comment nodes
            isCompatible = true;
            // Simply update nodeValue on the original node to
            // change the text value
            if (curFromNodeChild.nodeValue !== curToNodeChild.bx_) {
              curFromNodeChild.nodeValue = curToNodeChild.bx_;
            }
          }
        }

        if (isCompatible === true) {
          // Advance both the "to" child and the "from" child since we found a match
          curToNodeChild = toNextSibling;
          curFromNodeChild = fromNextSibling;
          continue outer;
        }

        detachNode(curFromNodeChild, fromNode, ownerComponent);
        curFromNodeChild = fromNextSibling;
      } // END: while (curFromNodeChild)

      // If we got this far then we did not find a candidate match for
      // our "to node" and we exhausted all of the children "from"
      // nodes. Therefore, we will just append the current "to" node
      // to the end
      insertVirtualNodeBefore(curToNodeChild, curToNodeKey, curFromNodeChild, fromNode, ownerComponent, parentComponent);

      curToNodeChild = toNextSibling;
      curFromNodeChild = fromNextSibling;
    }

    // We have processed all of the "to nodes".
    if (fromNode.bT_) {
      // If we are in an unfinished fragment, we have reached the end of the nodes
      // we were matching up and need to end the fragment
      fromNode.bT_(curFromNodeChild);
    } else {
      // If curFromNodeChild is non-null then we still have some from nodes
      // left over that need to be removed
      var fragmentBoundary = fromNode.nodeType === FRAGMENT_NODE ? fromNode.endNode : null;

      while (curFromNodeChild && curFromNodeChild !== fragmentBoundary) {
        fromNextSibling = nextSibling(curFromNodeChild);

        if (fromComponent = componentByDOMNode.get(curFromNodeChild)) {
          curFromNodeChild = fromNextSibling;
          if (!globalComponentsContext._S_[fromComponent.id]) {
            destroyComponent(fromComponent);
          }
          continue;
        }

        curVFromNodeChild = vElementByDOMNode.get(curFromNodeChild);

        // For transcluded content, we need to check if the element belongs to a different component
        // context than the current component and ensure it gets removed from its key index.
        if (isAutoKey(keysByDOMNode.get(fromNode))) {
          referenceComponent = parentComponent;
        } else {
          referenceComponent = curVFromNodeChild && curVFromNodeChild.aG_;
        }

        detachNode(curFromNodeChild, fromNode, referenceComponent);

        curFromNodeChild = fromNextSibling;
      }
    }
  }

  function morphEl(fromEl, vFromEl, toEl, toElKey, ownerComponent, parentComponent) {
    var nodeName = toEl.bG_;

    if (isHydrate === true && toElKey) {
      var referenceComponent = isAutoKey(toElKey) ? parentComponent : ownerComponent;
      referenceComponent.o_[toElKey] = fromEl;
    }

    var constId = toEl.bI_;
    if (constId !== undefined && vFromEl.bI_ === constId) {
      return;
    }

    morphAttrs(fromEl, vFromEl, toEl);

    if (nodeName !== "textarea") {
      morphChildren(fromEl, toEl, parentComponent);
    }

    var specialElHandler = specialElHandlers[nodeName];
    if (specialElHandler !== undefined) {
      specialElHandler(fromEl, toEl);
    }
  } // END: morphEl(...)

  morphChildren(fromNode, toNode, toNode.m_);

  detachedNodes.forEach(function (node) {
    var detachedFromComponent = detachedByDOMNode.get(node);

    if (detachedFromComponent !== undefined) {
      detachedByDOMNode.set(node, undefined);

      var componentToDestroy = componentByDOMNode.get(node);
      if (componentToDestroy) {
        componentToDestroy.destroy();
      } else if (node.parentNode) {
        destroyNodeRecursive(node, detachedFromComponent !== true && detachedFromComponent);

        if (eventDelegation._d_(node) != false) {
          removeChild(node);
        }
      }
    }
  });
}

module.exports = morphdom;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/Component", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var complain;

var domInsert = require('/marko$4.19.8/dist/runtime/dom-insert'/*"../dom-insert"*/);
var defaultCreateOut = require('/marko$4.19.8/dist/runtime/createOut'/*"../createOut"*/);
var getComponentsContext = require('/marko$4.19.8/dist/runtime/components/ComponentsContext'/*"./ComponentsContext"*/).r_;
var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.F_;
var emitLifecycleEvent = componentsUtil.G_;
var destroyNodeRecursive = componentsUtil.H_;
var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var RenderResult = require('/marko$4.19.8/dist/runtime/RenderResult'/*"../RenderResult"*/);
var SubscriptionTracker = require('/listener-tracker$2.0.0/lib/listener-tracker'/*"listener-tracker"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);
var updateManager = require('/marko$4.19.8/dist/runtime/components/update-manager'/*"./update-manager"*/);
var morphdom = require('/marko$4.19.8/dist/runtime/vdom/morphdom/index'/*"../vdom/morphdom"*/);
var eventDelegation = require('/marko$4.19.8/dist/runtime/components/event-delegation'/*"./event-delegation"*/);
var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"./dom-data"*/);
var componentsByDOMNode = domData.I_;
var keyedElementsByComponentId = domData.J_;
var CONTEXT_KEY = "__subtree_context__";

var slice = Array.prototype.slice;

var COMPONENT_SUBSCRIBE_TO_OPTIONS;
var NON_COMPONENT_SUBSCRIBE_TO_OPTIONS = {
  addDestroyListener: false
};

var emit = EventEmitter.prototype.emit;
var ELEMENT_NODE = 1;

function removeListener(removeEventListenerHandle) {
  removeEventListenerHandle();
}

function walkFragments(fragment) {
  var node;

  while (fragment) {
    node = fragment.firstChild;

    if (!node) {
      break;
    }

    fragment = node.fragment;
  }

  return node;
}

function handleCustomEventWithMethodListener(component, targetMethodName, args, extraArgs) {
  // Remove the "eventType" argument
  args.push(component);

  if (extraArgs) {
    args = extraArgs.concat(args);
  }

  var targetComponent = componentLookup[component.K_];
  var targetMethod = typeof targetMethodName === "function" ? targetMethodName : targetComponent[targetMethodName];
  if (!targetMethod) {
    throw Error("Method not found: " + targetMethodName);
  }

  targetMethod.apply(targetComponent, args);
}

function resolveKeyHelper(key, index) {
  return index ? key + "_" + index : key;
}

function resolveComponentIdHelper(component, key, index) {
  return component.id + "-" + resolveKeyHelper(key, index);
}

/**
 * This method is used to process "update_<stateName>" handler functions.
 * If all of the modified state properties have a user provided update handler
 * then a rerender will be bypassed and, instead, the DOM will be updated
 * looping over and invoking the custom update handlers.
 * @return {boolean} Returns true if if the DOM was updated. False, otherwise.
 */
function processUpdateHandlers(component, stateChanges, oldState) {
  var handlerMethod;
  var handlers;

  for (var propName in stateChanges) {
    if (stateChanges.hasOwnProperty(propName)) {
      var handlerMethodName = "update_" + propName;

      handlerMethod = component[handlerMethodName];
      if (handlerMethod) {
        (handlers || (handlers = [])).push([propName, handlerMethod]);
      } else {
        // This state change does not have a state handler so return false
        // to force a rerender
        return;
      }
    }
  }

  // If we got here then all of the changed state properties have
  // an update handler or there are no state properties that actually
  // changed.
  if (handlers) {
    // Otherwise, there are handlers for all of the changed properties
    // so apply the updates using those handlers

    handlers.forEach(function (handler) {
      var propertyName = handler[0];
      handlerMethod = handler[1];

      var newValue = stateChanges[propertyName];
      var oldValue = oldState[propertyName];
      handlerMethod.call(component, newValue, oldValue);
    });

    emitLifecycleEvent(component, "update");

    component.L_();
  }

  return true;
}

function checkInputChanged(existingComponent, oldInput, newInput) {
  if (oldInput != newInput) {
    if (oldInput == null || newInput == null) {
      return true;
    }

    var oldKeys = Object.keys(oldInput);
    var newKeys = Object.keys(newInput);
    var len = oldKeys.length;
    if (len !== newKeys.length) {
      return true;
    }

    for (var i = 0; i < len; i++) {
      var key = oldKeys[i];
      if (oldInput[key] !== newInput[key]) {
        return true;
      }
    }
  }

  return false;
}

var componentProto;

/**
 * Base component type.
 *
 * NOTE: Any methods that are prefixed with an underscore should be considered private!
 */
function Component(id) {
  EventEmitter.call(this);
  this.id = id;
  this.M_ = null;
  this.N_ = null;
  this.O_ = null;
  this.P_ = null;
  this.Q_ = null; // Used to keep track of bubbling DOM events for components rendered on the server
  this.R_ = null;
  this.K_ = null;
  this.S_ = null;
  this.T_ = undefined;
  this.U_ = false;
  this.V_ = undefined;
  this.W_ = false;
  this.X_ = false;
  this.Y_ = false;
  this.Z_ = false;
  this.___ = undefined;
  this._a_ = undefined;

  var ssrKeyedElements = keyedElementsByComponentId[id];

  if (ssrKeyedElements) {
    this.o_ = ssrKeyedElements;
    delete keyedElementsByComponentId[id];
  } else {
    this.o_ = {};
  }
}

Component.prototype = componentProto = {
  _b_: true,

  subscribeTo: function (target) {
    if (!target) {
      throw TypeError();
    }

    var subscriptions = this.O_ || (this.O_ = new SubscriptionTracker());

    var subscribeToOptions = target._b_ ? COMPONENT_SUBSCRIBE_TO_OPTIONS : NON_COMPONENT_SUBSCRIBE_TO_OPTIONS;

    return subscriptions.subscribeTo(target, subscribeToOptions);
  },

  emit: function (eventType) {
    var customEvents = this.R_;
    var target;

    if (customEvents && (target = customEvents[eventType])) {
      var targetMethodName = target[0];
      var isOnce = target[1];
      var extraArgs = target[2];
      var args = slice.call(arguments, 1);

      handleCustomEventWithMethodListener(this, targetMethodName, args, extraArgs);

      if (isOnce) {
        delete customEvents[eventType];
      }
    }

    if (this.listenerCount(eventType)) {
      return emit.apply(this, arguments);
    }
  },
  getElId: function (key, index) {
    if (!key) {
      return this.id;
    }
    return resolveComponentIdHelper(this, key, index);
  },
  getEl: function (key, index) {
    if (key) {
      var resolvedKey = resolveKeyHelper(key, index);
      var keyedElement = this.o_["@" + resolvedKey];

      if (!keyedElement) {
        var keyedComponentRoot = this.o_[resolvedKey];

        if (keyedComponentRoot) {

          return keyedComponentRoot.nodeType === 1 /** Node.ELEMENT_NODE */
          ? keyedComponentRoot : walkFragments(keyedComponentRoot);
          // eslint-disable-next-line no-constant-condition
        }
      }

      return keyedElement;
    } else {
      return this.el;
    }
  },
  getEls: function (key) {
    key = key + "[]";

    var els = [];
    var i = 0;
    var el;
    while (el = this.getEl(key, i)) {
      els.push(el);
      i++;
    }
    return els;
  },
  getComponent: function (key, index) {
    var rootNode = this.o_[resolveKeyHelper(key, index)];
    if (/\[\]$/.test(key)) {
      rootNode = rootNode && rootNode[Object.keys(rootNode)[0]];
      // eslint-disable-next-line no-constant-condition
    }
    return rootNode && componentsByDOMNode.get(rootNode);
  },
  getComponents: function (key) {
    var lookup = this.o_[key + "[]"];
    return lookup ? Object.keys(lookup).map(function (key) {
      return componentsByDOMNode.get(lookup[key]);
    }).filter(Boolean) : [];
  },
  destroy: function () {
    if (this.W_) {
      return;
    }

    var root = this.N_;

    this._c_();

    var nodes = root.nodes;

    nodes.forEach(function (node) {
      destroyNodeRecursive(node);

      if (eventDelegation._d_(node) !== false) {
        node.parentNode.removeChild(node);
      }
    });

    root.detached = true;

    delete componentLookup[this.id];
    this.o_ = {};
  },

  _c_: function () {
    if (this.W_) {
      return;
    }

    emitLifecycleEvent(this, "destroy");
    this.W_ = true;

    componentsByDOMNode.set(this.N_, undefined);

    this.N_ = null;

    // Unsubscribe from all DOM events
    this._e_();

    var subscriptions = this.O_;
    if (subscriptions) {
      subscriptions.removeAllListeners();
      this.O_ = null;
    }
  },

  isDestroyed: function () {
    return this.W_;
  },
  get state() {
    return this.M_;
  },
  set state(newState) {
    var state = this.M_;
    if (!state && !newState) {
      return;
    }

    if (!state) {
      state = this.M_ = new this._f_(this);
    }

    state._g_(newState || {});

    if (state.Y_) {
      this._h_();
    }

    if (!newState) {
      this.M_ = null;
    }
  },
  setState: function (name, value) {
    var state = this.M_;

    if (!state) {
      state = this.M_ = new this._f_(this);
    }
    if (typeof name == "object") {
      // Merge in the new state with the old state
      var newState = name;
      for (var k in newState) {
        if (newState.hasOwnProperty(k)) {
          state._i_(k, newState[k], true /* ensure:true */);
        }
      }
    } else {
      state._i_(name, value, true /* ensure:true */);
    }
  },

  setStateDirty: function (name, value) {
    var state = this.M_;

    if (arguments.length == 1) {
      value = state[name];
    }

    state._i_(name, value, true /* ensure:true */
    , true /* forceDirty:true */
    );
  },

  replaceState: function (newState) {
    this.M_._g_(newState);
  },

  get input() {
    return this.T_;
  },
  set input(newInput) {
    if (this.Z_) {
      this.T_ = newInput;
    } else {
      this._j_(newInput);
    }
  },

  _j_: function (newInput, onInput, out) {
    onInput = onInput || this.onInput;
    var updatedInput;

    var oldInput = this.T_;
    this.T_ = undefined;
    this._k_ = out && out[CONTEXT_KEY] || this._k_;

    if (onInput) {
      // We need to set a flag to preview `this.input = foo` inside
      // onInput causing infinite recursion
      this.Z_ = true;
      updatedInput = onInput.call(this, newInput || {}, out);
      this.Z_ = false;
    }

    newInput = this.S_ = updatedInput || newInput;

    if (this.Y_ = checkInputChanged(this, oldInput, newInput)) {
      this._h_();
    }

    if (this.T_ === undefined) {
      this.T_ = newInput;
      if (newInput && newInput.$global) {
        this.V_ = newInput.$global;
      }
    }

    return newInput;
  },

  forceUpdate: function () {
    this.Y_ = true;
    this._h_();
  },

  _h_: function () {
    if (!this.X_) {
      this.X_ = true;
      updateManager._l_(this);
    }
  },

  update: function () {
    if (this.W_ === true || this._m_ === false) {
      return;
    }

    var input = this.T_;
    var state = this.M_;

    if (this.Y_ === false && state !== null && state.Y_ === true) {
      if (processUpdateHandlers(this, state._n_, state._o_, state)) {
        state.Y_ = false;
      }
    }

    if (this._m_ === true) {
      // The UI component is still dirty after process state handlers
      // then we should rerender

      if (this.shouldUpdate(input, state) !== false) {
        this._p_();
      }
    }

    this.L_();
  },

  get _m_() {
    return this.Y_ === true || this.M_ !== null && this.M_.Y_ === true;
  },

  L_: function () {
    this.Y_ = false;
    this.X_ = false;
    this.S_ = null;
    var state = this.M_;
    if (state) {
      state.L_();
    }
  },

  shouldUpdate: function () {
    return true;
  },

  G_: function (eventType, eventArg1, eventArg2) {
    emitLifecycleEvent(this, eventType, eventArg1, eventArg2);
  },

  _p_: function () {
    var self = this;
    var renderer = self._q_;

    if (!renderer) {
      throw TypeError();
    }

    var input = this.S_ || this.T_;

    updateManager._r_(function () {
      self._s_(input, false).afterInsert(self.___);
    });

    this.L_();
  },

  _s_: function (input, isHydrate) {
    var doc = this.___;
    var globalData = this.V_;
    var rootNode = this.N_;
    var renderer = this._q_;
    var createOut = renderer.createOut || defaultCreateOut;
    var out = createOut(globalData);
    out.sync();
    out.___ = this.___;
    out[CONTEXT_KEY] = this._k_;

    var componentsContext = getComponentsContext(out);
    var globalComponentsContext = componentsContext.j_;
    globalComponentsContext._t_ = this;
    globalComponentsContext.k_ = isHydrate;

    renderer(input, out);

    var result = new RenderResult(out);

    var targetNode = out.E_().a_;

    morphdom(rootNode, targetNode, doc, componentsContext);

    return result;
  },

  _u_: function () {
    var root = this.N_;
    root.remove();
    return root;
  },

  _e_: function () {
    var eventListenerHandles = this.P_;
    if (eventListenerHandles) {
      eventListenerHandles.forEach(removeListener);
      this.P_ = null;
    }
  },

  get _v_() {
    var state = this.M_;
    return state && state._w_;
  },

  _x_: function (customEvents, scope) {
    var finalCustomEvents = this.R_ = {};
    this.K_ = scope;

    customEvents.forEach(function (customEvent) {
      var eventType = customEvent[0];
      var targetMethodName = customEvent[1];
      var isOnce = customEvent[2];
      var extraArgs = customEvent[3];

      finalCustomEvents[eventType] = [targetMethodName, isOnce, extraArgs];
    });
  },

  get el() {
    return walkFragments(this.N_);
  },

  get els() {
    return (this.N_ ? this.N_.nodes : []).filter(function (el) {
      return el.nodeType === ELEMENT_NODE;
    });
    // eslint-disable-next-line no-constant-condition
  }
};

componentProto.elId = componentProto.getElId;
componentProto._y_ = componentProto.update;
componentProto._z_ = componentProto.destroy;

// Add all of the following DOM methods to Component.prototype:
// - appendTo(referenceEl)
// - replace(referenceEl)
// - replaceChildrenOf(referenceEl)
// - insertBefore(referenceEl)
// - insertAfter(referenceEl)
// - prependTo(referenceEl)
domInsert(componentProto, function getEl(component) {
  return component._u_();
}, function afterInsert(component) {
  return component;
});

inherit(Component, EventEmitter);

module.exports = Component;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/defineComponent", function(require, exports, module, __filename, __dirname) { "use strict";
/* jshint newcap:false */

var BaseState = require('/marko$4.19.8/dist/runtime/components/State'/*"./State"*/);
var BaseComponent = require('/marko$4.19.8/dist/runtime/components/Component'/*"./Component"*/);
var inherit = require('/raptor-util$3.2.0/inherit'/*"raptor-util/inherit"*/);

module.exports = function defineComponent(def, renderer) {
  if (def._b_) {
    return def;
  }

  var ComponentClass = function () {};
  var proto;

  var type = typeof def;

  if (type == "function") {
    proto = def.prototype;
  } else if (type == "object") {
    proto = def;
  } else {
    throw TypeError();
  }

  ComponentClass.prototype = proto;

  // We don't use the constructor provided by the user
  // since we don't invoke their constructor until
  // we have had a chance to do our own initialization.
  // Instead, we store their constructor in the "initComponent"
  // property and that method gets called later inside
  // init-components-browser.js
  function Component(id) {
    BaseComponent.call(this, id);
  }

  if (!proto._b_) {
    // Inherit from Component if they didn't already
    inherit(ComponentClass, BaseComponent);
  }

  // The same prototype will be used by our constructor after
  // we he have set up the prototype chain using the inherit function
  proto = Component.prototype = ComponentClass.prototype;

  // proto.constructor = def.constructor = Component;

  // Set a flag on the constructor function to make it clear this is
  // a component so that we can short-circuit this work later
  Component._b_ = true;

  function State(component) {
    BaseState.call(this, component);
  }
  inherit(State, BaseState);
  proto._f_ = State;
  proto._q_ = renderer;

  return Component;
};
});
$_mod.main("/marko$4.19.8/dist/loader", "");
$_mod.remap("/marko$4.19.8/dist/loader/index", "/marko$4.19.8/dist/loader/index-browser");
$_mod.def("/marko$4.19.8/dist/loader/index-browser", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function load(templatePath) {
  // We make the assumption that the template path is a
  // fully resolved module path and that the module exists
  // as a CommonJS module
  // eslint-disable-next-line no-undef
  if (typeof __webpack_require__ !== "undefined") {
    // In webpack we can accept paths from `require.resolve`.
    // eslint-disable-next-line no-undef
    return __webpack_require__(templatePath);
  } else {
    return require(templatePath);
  }
};
});
$_mod.def("/marko$4.19.8/dist/runtime/components/registry-browser", function(require, exports, module, __filename, __dirname) { var complain;
var defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"./defineComponent"*/);
var loader = require('/marko$4.19.8/dist/loader/index-browser'/*"../../loader"*/);
require('/marko$4.19.8/dist/runtime/components/index-browser'/*"."*/);

var registered = {};
var loaded = {};
var componentTypes = {};

function register(componentId, def) {
  registered[componentId] = def;
  delete loaded[componentId];
  delete componentTypes[componentId];
  return componentId;
}

function load(typeName, isLegacy) {
  var target = loaded[typeName];
  if (!target) {
    target = registered[typeName];

    if (target) {
      target = target();
    } else if (isLegacy) {
      target = window.$markoLegacy.load(typeName);
    } else {
      target = loader(typeName);
      // eslint-disable-next-line no-constant-condition
    }

    if (!target) {
      throw Error("Component not found: " + typeName);
    }

    loaded[typeName] = target;
  }

  return target;
}

function getComponentClass(typeName, isLegacy) {
  var ComponentClass = componentTypes[typeName];

  if (ComponentClass) {
    return ComponentClass;
  }

  ComponentClass = load(typeName, isLegacy);

  ComponentClass = ComponentClass.Component || ComponentClass;

  if (!ComponentClass._b_) {
    ComponentClass = defineComponent(ComponentClass, ComponentClass.renderer);
  }

  // Make the component "type" accessible on each component instance
  ComponentClass.prototype.e_ = typeName;

  // eslint-disable-next-line no-constant-condition


  componentTypes[typeName] = ComponentClass;

  return ComponentClass;
}

function createComponent(typeName, id, isLegacy) {
  var ComponentClass = getComponentClass(typeName, isLegacy);
  return new ComponentClass(id);
}

exports.r = register;
exports._L_ = createComponent;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/init-components-browser", function(require, exports, module, __filename, __dirname) { "use strict";

var warp10Finalize = require('/warp10$2.0.1/finalize'/*"warp10/finalize"*/);
var eventDelegation = require('/marko$4.19.8/dist/runtime/components/event-delegation'/*"./event-delegation"*/);
var win = window;
var defaultDocument = document;
var createFragmentNode = require('/marko$4.19.8/dist/runtime/vdom/morphdom/fragment'/*"../vdom/morphdom/fragment"*/).am_;
var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.F_;
var addComponentRootToKeyedElements = componentsUtil.an_;
var ComponentDef = require('/marko$4.19.8/dist/runtime/components/ComponentDef'/*"./ComponentDef"*/);
var registry = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"./registry"*/);
var domData = require('/marko$4.19.8/dist/runtime/components/dom-data'/*"./dom-data"*/);
var keyedElementsByComponentId = domData.J_;
var componentsByDOMNode = domData.I_;
var serverRenderedGlobals = {};
var serverComponentRootNodes = {};

var FLAG_WILL_RERENDER_IN_BROWSER = 1;

function indexServerComponentBoundaries(node, runtimeId, stack) {
  var componentId;
  var ownerId;
  var ownerComponent;
  var keyedElements;
  var nextSibling;
  var runtimeLength = runtimeId.length;
  stack = stack || [];

  node = node.firstChild;
  while (node) {
    nextSibling = node.nextSibling;
    if (node.nodeType === 8) {
      // Comment node
      var commentValue = node.nodeValue;
      if (commentValue.slice(0, runtimeLength) === runtimeId) {
        var firstChar = commentValue[runtimeLength];

        if (firstChar === "^" || firstChar === "#") {
          stack.push(node);
        } else if (firstChar === "/") {
          var endNode = node;
          var startNode = stack.pop();
          var rootNode;

          if (startNode.parentNode === endNode.parentNode) {
            rootNode = createFragmentNode(startNode.nextSibling, endNode);
          } else {
            rootNode = createFragmentNode(endNode.parentNode.firstChild, endNode);
          }

          componentId = startNode.nodeValue.substring(runtimeLength + 1);
          firstChar = startNode.nodeValue[runtimeLength];

          if (firstChar === "^") {
            var parts = componentId.split(/ /g);
            var key = parts[2];
            ownerId = parts[1];
            componentId = parts[0];
            if (ownerComponent = componentLookup[ownerId]) {
              keyedElements = ownerComponent.o_;
            } else {
              keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
            }
            addComponentRootToKeyedElements(keyedElements, key, rootNode, componentId);
          }

          serverComponentRootNodes[componentId] = rootNode;

          startNode.parentNode.removeChild(startNode);
          endNode.parentNode.removeChild(endNode);
        }
      }
    } else if (node.nodeType === 1) {
      // HTML element node
      var markoKey = node.getAttribute("data-marko-key");
      var markoProps = node.getAttribute("data-marko");
      if (markoKey) {
        var separatorIndex = markoKey.indexOf(" ");
        ownerId = markoKey.substring(separatorIndex + 1);
        markoKey = markoKey.substring(0, separatorIndex);
        if (ownerComponent = componentLookup[ownerId]) {
          keyedElements = ownerComponent.o_;
        } else {
          keyedElements = keyedElementsByComponentId[ownerId] || (keyedElementsByComponentId[ownerId] = {});
        }
        keyedElements[markoKey] = node;
      }
      if (markoProps) {
        markoProps = JSON.parse(markoProps);
        Object.keys(markoProps).forEach(function (key) {
          if (key.slice(0, 2) === "on") {
            eventDelegation._B_(key.slice(2));
          }
        });
      }
      indexServerComponentBoundaries(node, runtimeId, stack);
    }

    node = nextSibling;
  }
}

function invokeComponentEventHandler(component, targetMethodName, args) {
  var method = component[targetMethodName];
  if (!method) {
    throw Error("Method not found: " + targetMethodName);
  }

  method.apply(component, args);
}

function addEventListenerHelper(el, eventType, isOnce, listener) {
  var eventListener = listener;
  if (isOnce) {
    eventListener = function (event) {
      listener(event);
      el.removeEventListener(eventType, eventListener);
    };
  }

  el.addEventListener(eventType, eventListener, false);

  return function remove() {
    el.removeEventListener(eventType, eventListener);
  };
}

function addDOMEventListeners(component, el, eventType, targetMethodName, isOnce, extraArgs, handles) {
  var removeListener = addEventListenerHelper(el, eventType, isOnce, function (event) {
    var args = [event, el];
    if (extraArgs) {
      args = extraArgs.concat(args);
    }

    invokeComponentEventHandler(component, targetMethodName, args);
  });
  handles.push(removeListener);
}

function initComponent(componentDef, doc) {
  var component = componentDef.m_;

  if (!component || !component._b_) {
    return; // legacy
  }

  component.L_();
  component.___ = doc;

  var isExisting = componentDef._E_;

  if (isExisting) {
    component._e_();
  }

  var domEvents = componentDef._D_;
  if (domEvents) {
    var eventListenerHandles = [];

    domEvents.forEach(function (domEventArgs) {
      // The event mapping is for a direct DOM event (not a custom event and not for bubblign dom events)

      var eventType = domEventArgs[0];
      var targetMethodName = domEventArgs[1];
      var eventEl = component.o_[domEventArgs[2]];
      var isOnce = domEventArgs[3];
      var extraArgs = domEventArgs[4];

      addDOMEventListeners(component, eventEl, eventType, targetMethodName, isOnce, extraArgs, eventListenerHandles);
    });

    if (eventListenerHandles.length) {
      component.P_ = eventListenerHandles;
    }
  }

  if (component.U_) {
    component.G_("update");
  } else {
    component.U_ = true;
    component.G_("mount");
  }
}

/**
 * This method is used to initialized components associated with UI components
 * rendered in the browser. While rendering UI components a "components context"
 * is added to the rendering context to keep up with which components are rendered.
 * When ready, the components can then be initialized by walking the component tree
 * in the components context (nested components are initialized before ancestor components).
 * @param  {Array<marko-components/lib/ComponentDef>} componentDefs An array of ComponentDef instances
 */
function initClientRendered(componentDefs, doc) {
  // Ensure that event handlers to handle delegating events are
  // always attached before initializing any components
  eventDelegation.ai_(doc);

  doc = doc || defaultDocument;
  var len = componentDefs.length;
  var componentDef;
  var i;

  for (i = len; i--;) {
    componentDef = componentDefs[i];
    trackComponent(componentDef);
  }

  for (i = len; i--;) {
    componentDef = componentDefs[i];
    initComponent(componentDef, doc);
  }
}

/**
 * This method initializes all components that were rendered on the server by iterating over all
 * of the component IDs.
 */
function initServerRendered(renderedComponents, doc) {
  var type = typeof renderedComponents;
  var runtimeId;

  if (type !== "object") {
    var componentsKey = "$" + (type === "string" ? renderedComponents + "_components" : "components");
    renderedComponents = win[componentsKey];

    if (renderedComponents && renderedComponents.forEach) {
      renderedComponents.forEach(function (renderedComponent) {
        initServerRendered(renderedComponent, doc);
      });
    }

    win[componentsKey] = {
      concat: initServerRendered
    };

    return;
  }

  doc = doc || defaultDocument;

  renderedComponents = warp10Finalize(renderedComponents);

  runtimeId = renderedComponents.r;
  var componentDefs = renderedComponents.w;
  var typesArray = renderedComponents.t;
  var markoGlobalsKey = "$" + runtimeId + "G";

  // Ensure that event handlers to handle delegating events are
  // always attached before initializing any components
  indexServerComponentBoundaries(doc, runtimeId);
  eventDelegation.ai_(doc);

  var globals = win[markoGlobalsKey];
  if (globals) {
    serverRenderedGlobals = warp10Finalize(globals);
    delete win[markoGlobalsKey];
  }

  // hydrate components top down (leaf nodes last)
  // and return an array of functions to mount these components
  var deferredDefs;
  componentDefs.map(function (componentDef) {
    componentDef = ComponentDef._K_(componentDef, typesArray, serverRenderedGlobals, registry);

    var mount = hydrateComponentAndGetMount(componentDef, doc);

    if (!mount) {
      // hydrateComponentAndGetMount will return false if there is not rootNode
      // for the component.  If this is the case, we'll wait until the
      // DOM has fully loaded to attempt to init the component again.
      if (deferredDefs) {
        deferredDefs.push(componentDef);
      } else {
        deferredDefs = [componentDef];
        doc.addEventListener("DOMContentLoaded", function () {
          indexServerComponentBoundaries(doc, runtimeId);
          deferredDefs.map(function (componentDef) {
            return hydrateComponentAndGetMount(componentDef, doc);
          }).reverse().forEach(tryInvoke);
        });
      }
    }

    return mount;
  }).reverse().forEach(tryInvoke);
}

function hydrateComponentAndGetMount(componentDef, doc) {
  var componentId = componentDef.id;
  var component = componentDef.m_;
  var rootNode = serverComponentRootNodes[componentId];
  var renderResult;

  if (rootNode) {
    delete serverComponentRootNodes[componentId];

    component.N_ = rootNode;
    componentsByDOMNode.set(rootNode, component);

    if (componentDef._G_ & FLAG_WILL_RERENDER_IN_BROWSER) {
      component.___ = doc;
      renderResult = component._s_(component.T_, true);
      trackComponent(componentDef);
      return function mount() {
        renderResult.afterInsert(doc);
      };
    } else {
      trackComponent(componentDef);
    }

    return function mount() {
      initComponent(componentDef, doc);
    };
  }
}

function trackComponent(componentDef) {
  var component = componentDef.m_;
  if (component) {
    componentLookup[component.id] = component;
  }
}

function tryInvoke(fn) {
  if (fn) fn();
}

exports._P_ = initClientRendered;
exports.ak_ = initServerRendered;
});
$_mod.def("/marko$4.19.8/dist/runtime/components/index-browser", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var initComponents = require('/marko$4.19.8/dist/runtime/components/init-components-browser'/*"./init-components"*/);
var registry = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"./registry"*/);

require('/marko$4.19.8/dist/runtime/components/ComponentsContext'/*"./ComponentsContext"*/)._P_ = initComponents._P_;

exports.getComponentForEl = componentsUtil.aj_;
exports.init = window.$initComponents = initComponents.ak_;

exports.register = function (id, component) {
  registry.r(id, function () {
    return component;
  });
};
});
$_mod.def("/marko$4.19.8/components-browser.marko", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.19.8/dist/runtime/components/index-browser'/*"./dist/runtime/components"*/);

});
$_mod.main("/app$1.0.0/src/routes/mobile/components/app", "index.marko");
$_mod.main("/marko$4.19.8/dist/runtime/vdom", "");
$_mod.main("/marko$4.19.8/dist", "");
$_mod.remap("/marko$4.19.8/dist/index", "/marko$4.19.8/dist/index-browser");
$_mod.def("/marko$4.19.8/dist/index-browser", function(require, exports, module, __filename, __dirname) { "use strict";

exports.createOut = require('/marko$4.19.8/dist/runtime/createOut'/*"./runtime/createOut"*/);
exports.load = require('/marko$4.19.8/dist/loader/index-browser'/*"./loader"*/);
});
$_mod.def("/marko$4.19.8/dist/runtime/helpers/class-value", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function classHelper(arg) {
  var len,
      name,
      value,
      str = "";

  if (arg) {
    if (typeof arg === "string") {
      if (arg) {
        str += " " + arg;
      }
    } else if (typeof (len = arg.length) === "number") {
      for (var i = 0; i < len; i++) {
        value = classHelper(arg[i]);
        if (value) {
          str += " " + value;
        }
      }
    } else if (typeof arg === "object") {
      for (name in arg) {
        value = arg[name];
        if (value) {
          str += " " + name;
        }
      }
    }
  }

  return str && str.slice(1) || null;
};
});
$_mod.def("/marko$4.19.8/dist/runtime/helpers/_change-case", function(require, exports, module, __filename, __dirname) { "use strict";

var camelToDashLookup = Object.create(null);
var dashToCamelLookup = Object.create(null);

/**
 * Helper for converting camelCase to dash-case.
 */
exports.aO_ = function camelToDashCase(name) {
  var nameDashed = camelToDashLookup[name];
  if (!nameDashed) {
    nameDashed = camelToDashLookup[name] = name.replace(/([A-Z])/g, "-$1").toLowerCase();

    if (nameDashed !== name) {
      dashToCamelLookup[nameDashed] = name;
    }
  }

  return nameDashed;
};

/**
 * Helper for converting dash-case to camelCase.
 */
exports.aP_ = function dashToCamelCase(name) {
  var nameCamel = dashToCamelLookup[name];
  if (!nameCamel) {
    nameCamel = dashToCamelLookup[name] = name.replace(/-([a-z])/g, matchToUpperCase);

    if (nameCamel !== name) {
      camelToDashLookup[nameCamel] = name;
    }
  }

  return nameCamel;
};

function matchToUpperCase(_, char) {
  return char.toUpperCase();
}
});
$_mod.def("/marko$4.19.8/dist/runtime/helpers/style-value", function(require, exports, module, __filename, __dirname) { "use strict";

var changeCase = require('/marko$4.19.8/dist/runtime/helpers/_change-case'/*"./_change-case"*/);

/**
 * Helper for generating the string for a style attribute
 */
module.exports = function styleHelper(style) {
  if (!style) {
    return null;
  }

  var type = typeof style;

  if (type !== "string") {
    var styles = "";

    if (Array.isArray(style)) {
      for (var i = 0, len = style.length; i < len; i++) {
        var next = styleHelper(style[i]);
        if (next) styles += next + (next[next.length - 1] !== ";" ? ";" : "");
      }
    } else if (type === "object") {
      for (var name in style) {
        var value = style[name];
        if (value != null) {
          if (typeof value === "number" && value) {
            value += "px";
          }

          styles += changeCase.aO_(name) + ":" + value + ";";
        }
      }
    }

    return styles || null;
  }

  return style;
};
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/helpers/attrs", function(require, exports, module, __filename, __dirname) { "use strict";

var complain;
var classHelper = require('/marko$4.19.8/dist/runtime/helpers/class-value'/*"../../helpers/class-value"*/);
var styleHelper = require('/marko$4.19.8/dist/runtime/helpers/style-value'/*"../../helpers/style-value"*/);

/**
 * Helper for processing dynamic attributes
 */
module.exports = function (attributes) {
  if (typeof attributes === "string") {
    return parseAttrs(attributes);
    // eslint-disable-next-line no-constant-condition
  }

  if (attributes) {
    var newAttributes = {};

    for (var attrName in attributes) {
      var val = attributes[attrName];
      if (attrName === "renderBody") {
        continue;
      }

      if (attrName === "class") {
        val = classHelper(val);
      } else if (attrName === "style") {
        val = styleHelper(val);
      }

      newAttributes[attrName] = val;
    }

    return newAttributes;
  }

  return attributes;
};

var parseContainer;
function parseAttrs(str) {
  if (str === "") {
    return {};
  }

  parseContainer = parseContainer || document.createElement("div");
  parseContainer.innerHTML = "<a " + str + ">";
  var attrs = parseContainer.firstChild.attributes;
  var result = {};
  var attr;

  for (var len = attrs.length, i = 0; i < len; i++) {
    attr = attrs[i];
    result[attr.name] = attr.value;
  }

  return result;
}
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/AsyncVDOMBuilder", function(require, exports, module, __filename, __dirname) { var EventEmitter = require('/events-light$1.0.5/src/index'/*"events-light"*/);
var vdom = require('/marko$4.19.8/dist/runtime/vdom/vdom'/*"./vdom"*/);
var VElement = vdom.aX_;
var VDocumentFragment = vdom.aY_;
var VComment = vdom.aZ_;
var VText = vdom.b__;
var VComponent = vdom.ba_;
var VFragment = vdom.bb_;
var virtualizeHTML = vdom.bc_;
var RenderResult = require('/marko$4.19.8/dist/runtime/RenderResult'/*"../RenderResult"*/);
var defaultDocument = vdom.bd_;
var morphdom = require('/marko$4.19.8/dist/runtime/vdom/morphdom/index'/*"./morphdom"*/);
var attrsHelper = require('/marko$4.19.8/dist/runtime/vdom/helpers/attrs'/*"./helpers/attrs"*/);

var EVENT_UPDATE = "update";
var EVENT_FINISH = "finish";

function State(tree) {
  this.be_ = new EventEmitter();
  this.bf_ = tree;
  this.bg_ = false;
}

function AsyncVDOMBuilder(globalData, parentNode, parentOut) {
  if (!parentNode) {
    parentNode = new VDocumentFragment();
  }

  var state;

  if (parentOut) {
    state = parentOut.M_;
  } else {
    state = new State(parentNode);
  }

  this.bh_ = 1;
  this.bi_ = 0;
  this.bj_ = null;
  this.bk_ = parentOut;

  this.data = {};
  this.M_ = state;
  this.aD_ = parentNode;
  this.global = globalData || {};
  this.bl_ = [parentNode];
  this.bm_ = false;
  this.bn_ = undefined;
  this.h_ = null;

  this.l_ = null;
  this.n_ = null;
  this.aB_ = null;
}

var proto = AsyncVDOMBuilder.prototype = {
  aT_: true,
  ___: defaultDocument,

  bc: function (component, key, ownerComponent) {
    var vComponent = new VComponent(component, key, ownerComponent);
    return this.bo_(vComponent, 0, true);
  },

  aE_: function (component, key, ownerComponent) {
    var vComponent = new VComponent(component, key, ownerComponent, true);
    this.bo_(vComponent, 0);
  },

  bo_: function (child, childCount, pushToStack) {
    this.aD_.bp_(child);
    if (pushToStack === true) {
      this.bl_.push(child);
      this.aD_ = child;
    }
    return childCount === 0 ? this : child;
  },

  element: function (tagName, attrs, key, component, childCount, flags, props) {
    var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
    return this.bo_(element, childCount);
  },

  aS_: function (tagName, attrs, key, componentDef, props) {
    return this.element(tagName, attrsHelper(attrs), key, componentDef.m_, 0, 0, props);
  },

  n: function (node, component) {
    // NOTE: We do a shallow clone since we assume the node is being reused
    //       and a node can only have one parent node.
    var clone = node.__();
    this.node(clone);
    clone.aG_ = component;

    return this;
  },

  node: function (node) {
    this.aD_.bp_(node);
    return this;
  },

  text: function (text, ownerComponent) {
    var type = typeof text;

    if (type != "string") {
      if (text == null) {
        return;
      } else if (type === "object") {
        if (text.toHTML) {
          return this.h(text.toHTML(), ownerComponent);
        }
      }

      text = text.toString();
    }

    this.aD_.bp_(new VText(text, ownerComponent));
    return this;
  },

  comment: function (comment, ownerComponent) {
    return this.node(new VComment(comment, ownerComponent));
  },

  html: function (html, ownerComponent) {
    if (html != null) {
      var vdomNode = virtualizeHTML(html, this.___ || document, ownerComponent);
      this.node(vdomNode);
    }

    return this;
  },

  beginElement: function (tagName, attrs, key, component, childCount, flags, props) {
    var element = new VElement(tagName, attrs, key, component, childCount, flags, props);
    this.bo_(element, childCount, true);
    return this;
  },

  aQ_: function (tagName, attrs, key, componentDef, props) {
    return this.beginElement(tagName, attrsHelper(attrs), key, componentDef.m_, 0, 0, props);
  },

  p_: function (key, component, preserve) {
    var fragment = new VFragment(key, component, preserve);
    this.bo_(fragment, null, true);
    return this;
  },

  q_: function () {
    this.endElement();
  },

  endElement: function () {
    var stack = this.bl_;
    stack.pop();
    this.aD_ = stack[stack.length - 1];
  },

  end: function () {
    this.aD_ = undefined;

    var remaining = --this.bh_;
    var parentOut = this.bk_;

    if (remaining === 0) {
      if (parentOut) {
        parentOut.bq_();
      } else {
        this.br_();
      }
    } else if (remaining - this.bi_ === 0) {
      this.bs_();
    }

    return this;
  },

  bq_: function () {
    var remaining = --this.bh_;

    if (remaining === 0) {
      var parentOut = this.bk_;
      if (parentOut) {
        parentOut.bq_();
      } else {
        this.br_();
      }
    } else if (remaining - this.bi_ === 0) {
      this.bs_();
    }
  },

  br_: function () {
    var state = this.M_;
    state.bg_ = true;
    state.be_.emit(EVENT_FINISH, this.aU_());
  },

  bs_: function () {
    var lastArray = this._last;

    var i = 0;

    function next() {
      if (i === lastArray.length) {
        return;
      }
      var lastCallback = lastArray[i++];
      lastCallback(next);

      if (!lastCallback.length) {
        next();
      }
    }

    next();
  },

  error: function (e) {
    try {
      this.emit("error", e);
    } finally {
      // If there is no listener for the error event then it will
      // throw a new Error here. In order to ensure that the async fragment
      // is still properly ended we need to put the end() in a `finally`
      // block
      this.end();
    }

    return this;
  },

  beginAsync: function (options) {
    if (this.bm_) {
      throw Error("Tried to render async while in sync mode. Note: Client side await is not currently supported in re-renders (Issue: #942).");
    }

    var state = this.M_;

    if (options) {
      if (options.last) {
        this.bi_++;
      }
    }

    this.bh_++;

    var documentFragment = this.aD_.bt_();
    var asyncOut = new AsyncVDOMBuilder(this.global, documentFragment, this);

    state.be_.emit("beginAsync", {
      out: asyncOut,
      parentOut: this
    });

    return asyncOut;
  },

  createOut: function () {
    return new AsyncVDOMBuilder(this.global);
  },

  flush: function () {
    var events = this.M_.be_;

    if (events.listenerCount(EVENT_UPDATE)) {
      events.emit(EVENT_UPDATE, new RenderResult(this));
    }
  },

  E_: function () {
    return this.M_.bf_;
  },

  aU_: function () {
    return this.bu_ || (this.bu_ = new RenderResult(this));
  },

  on: function (event, callback) {
    var state = this.M_;

    if (event === EVENT_FINISH && state.bg_) {
      callback(this.aU_());
    } else if (event === "last") {
      this.onLast(callback);
    } else {
      state.be_.on(event, callback);
    }

    return this;
  },

  once: function (event, callback) {
    var state = this.M_;

    if (event === EVENT_FINISH && state.bg_) {
      callback(this.aU_());
    } else if (event === "last") {
      this.onLast(callback);
    } else {
      state.be_.once(event, callback);
    }

    return this;
  },

  emit: function (type, arg) {
    var events = this.M_.be_;
    switch (arguments.length) {
      case 1:
        events.emit(type);
        break;
      case 2:
        events.emit(type, arg);
        break;
      default:
        events.emit.apply(events, arguments);
        break;
    }
    return this;
  },

  removeListener: function () {
    var events = this.M_.be_;
    events.removeListener.apply(events, arguments);
    return this;
  },

  sync: function () {
    this.bm_ = true;
  },

  isSync: function () {
    return this.bm_;
  },

  onLast: function (callback) {
    var lastArray = this._last;

    if (lastArray === undefined) {
      this._last = [callback];
    } else {
      lastArray.push(callback);
    }

    return this;
  },

  D_: function (doc) {
    var node = this.bn_;
    if (!node) {
      var vdomTree = this.E_();
      // Create the root document fragment node
      doc = doc || this.___ || document;
      this.bn_ = node = vdomTree.bv_(doc, null);
      morphdom(node, vdomTree, doc, this.h_);
    }
    return node;
  },

  toString: function (doc) {
    var docFragment = this.D_(doc);
    var html = "";

    var child = docFragment.firstChild;
    while (child) {
      var nextSibling = child.nextSibling;
      if (child.nodeType != 1) {
        var container = docFragment.ownerDocument.createElement("div");
        container.appendChild(child.cloneNode());
        html += container.innerHTML;
      } else {
        html += child.outerHTML;
      }

      child = nextSibling;
    }

    return html;
  },

  then: function (fn, fnErr) {
    var out = this;
    var promise = new Promise(function (resolve, reject) {
      out.on("error", reject).on(EVENT_FINISH, function (result) {
        resolve(result);
      });
    });

    return Promise.resolve(promise).then(fn, fnErr);
  },

  catch: function (fnErr) {
    return this.then(undefined, fnErr);
  },

  isVDOM: true,

  c: function (componentDef, key, customEvents) {
    this.l_ = componentDef;
    this.n_ = key;
    this.aB_ = customEvents;
  }
};

proto.e = proto.element;
proto.be = proto.beginElement;
proto.ee = proto.aR_ = proto.endElement;
proto.t = proto.text;
proto.h = proto.w = proto.write = proto.html;

module.exports = AsyncVDOMBuilder;
});
$_mod.def("/marko$4.19.8/dist/runtime/renderable", function(require, exports, module, __filename, __dirname) { var defaultCreateOut = require('/marko$4.19.8/dist/runtime/createOut'/*"./createOut"*/);
var extend = require('/raptor-util$3.2.0/extend'/*"raptor-util/extend"*/);

function safeRender(renderFunc, finalData, finalOut, shouldEnd) {
  try {
    renderFunc(finalData, finalOut);

    if (shouldEnd) {
      finalOut.end();
    }
  } catch (err) {
    var actualEnd = finalOut.end;
    finalOut.end = function () {};

    setTimeout(function () {
      finalOut.end = actualEnd;
      finalOut.error(err);
    }, 0);
  }
  return finalOut;
}

module.exports = function (target, renderer) {
  var renderFunc = renderer && (renderer.renderer || renderer.render || renderer);
  var createOut = target.createOut || renderer.createOut || defaultCreateOut;

  return extend(target, {
    createOut: createOut,

    renderToString: function (data, callback) {
      var localData = data || {};
      var render = renderFunc || this._;
      var globalData = localData.$global;
      var out = createOut(globalData);

      out.global.template = this;

      if (globalData) {
        localData.$global = undefined;
      }

      if (callback) {
        out.on("finish", function () {
          callback(null, out.toString(), out);
        }).once("error", callback);

        return safeRender(render, localData, out, true);
      } else {
        out.sync();
        render(localData, out);
        return out.toString();
      }
    },

    renderSync: function (data) {
      var localData = data || {};
      var render = renderFunc || this._;
      var globalData = localData.$global;
      var out = createOut(globalData);
      out.sync();

      out.global.template = this;

      if (globalData) {
        localData.$global = undefined;
      }

      render(localData, out);
      return out.aU_();
    },

    /**
     * Renders a template to either a stream (if the last
     * argument is a Stream instance) or
     * provides the output to a callback function (if the last
     * argument is a Function).
     *
     * Supported signatures:
     *
     * render(data)
     * render(data, out)
     * render(data, stream)
     * render(data, callback)
     *
     * @param  {Object} data The view model data for the template
     * @param  {AsyncStream/AsyncVDOMBuilder} out A Stream, an AsyncStream/AsyncVDOMBuilder instance, or a callback function
     * @return {AsyncStream/AsyncVDOMBuilder} Returns the AsyncStream/AsyncVDOMBuilder instance that the template is rendered to
     */
    render: function (data, out) {
      var callback;
      var finalOut;
      var finalData;
      var globalData;
      var render = renderFunc || this._;
      var shouldBuffer = this.aV_;
      var shouldEnd = true;

      if (data) {
        finalData = data;
        if (globalData = data.$global) {
          finalData.$global = undefined;
        }
      } else {
        finalData = {};
      }

      if (out && out.aT_) {
        finalOut = out;
        shouldEnd = false;
        extend(out.global, globalData);
      } else if (typeof out == "function") {
        finalOut = createOut(globalData);
        callback = out;
      } else {
        finalOut = createOut(globalData, // global
        out, // writer(AsyncStream) or parentNode(AsyncVDOMBuilder)
        undefined, // parentOut
        shouldBuffer // ignored by AsyncVDOMBuilder
        );
      }

      if (callback) {
        finalOut.on("finish", function () {
          callback(null, finalOut.aU_());
        }).once("error", callback);
      }

      globalData = finalOut.global;

      globalData.template = globalData.template || this;

      return safeRender(render, finalData, finalOut, shouldEnd);
    }
  });
};
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/index", function(require, exports, module, __filename, __dirname) { "use strict";

require('/marko$4.19.8/dist/index-browser'/*"../../"*/);

// helpers provide a core set of various utility methods
// that are available in every template
var AsyncVDOMBuilder = require('/marko$4.19.8/dist/runtime/vdom/AsyncVDOMBuilder'/*"./AsyncVDOMBuilder"*/);
var makeRenderable = require('/marko$4.19.8/dist/runtime/renderable'/*"../renderable"*/);

/**
 * Method is for internal usage only. This method
 * is invoked by code in a compiled Marko template and
 * it is used to create a new Template instance.
 * @private
 */
exports.t = function createTemplate(path) {
  return new Template(path);
};

function Template(path, func) {
  this.path = path;
  this._ = func;
  this.meta = undefined;
}

function createOut(globalData, parent, parentOut) {
  return new AsyncVDOMBuilder(globalData, parent, parentOut);
}

var Template_prototype = Template.prototype = {
  createOut: createOut
};

makeRenderable(Template_prototype);

exports.Template = Template;
exports.aW_ = createOut;

require('/marko$4.19.8/dist/runtime/createOut'/*"../createOut"*/).aK_(createOut);
});
$_mod.def("/marko$4.19.8/dist/vdom", function(require, exports, module, __filename, __dirname) { module.exports = require('/marko$4.19.8/dist/runtime/vdom/index'/*"./runtime/vdom"*/);
});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/routes", function(require, exports, module, __filename, __dirname) { var routes = [
// {
//   name: 'about',
//   path: '/about',
//   pageName: 'about',
// },
{
  name: 'home-page',
  path: '/home-page',
  pageName: 'home-page'
}, {
  name: 'login',
  path: '/login',
  pageName: 'login'
}];

exports.routes = routes;
});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/component", function(require, exports, module, __filename, __dirname) { var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var config = require('/app$1.0.0/src/routes/mobile/components/app/routes'/*'./routes'*/);
module.exports = function () {
  function _class() {
    _classCallCheck(this, _class);
  }

  _createClass(_class, [{
    key: 'onCreate',
    value: function onCreate() {}
  }, {
    key: 'onMount',
    value: function onMount() {
      this.start();
      this.addBackHandlers();
    }
  }, {
    key: 'addBackHandlers',
    value: function addBackHandlers() {
      Dom7("a.move-back").on('click', function () {
        window.app.views.main.router.back();
      });
    }
  }, {
    key: 'start',
    value: function start() {
      var theme = 'auto';
      if (document.location.search.indexOf('theme=') >= 0) {
        theme = document.location.search.split('theme=')[1].split('&')[0];
      }
      var app = new Framework7({
        theme: theme,
        root: '#app',

        name: 'My App',

        id: 'com.myapp.test',

        panel: {
          swipe: 'left'
        },

        routes: config.routes

      });
      var mainView = app.views.create('.view-main', {
        stackPages: true,
        pushState: true,
        url: "/mobile"

      });
      window.app = app;
      var thisComp = this;
      var informChild = function (pageName, eventHandler) {
        var page = thisComp.getComponent(pageName);
        page && typeof page[eventHandler] === 'function' && page[eventHandler]();
      };
      setTimeout(function () {

        var router = app.views.main.router;

        informChild(router.currentRoute.name, 'pageAfterIn');
        informChild(router.currentRoute.name, 'pageBeforeIn');

        app.on('pageBeforeIn', function (page) {

          informChild(page.name, 'pageBeforeIn');
        });
        app.on('pageAfterIn', function (page) {
          informChild(page.name, 'pageAfterIn');
        });

        app.on('pageBeforeOut', function (page) {
          informChild(page.name, 'pageBeforeOut');
        });
        app.on('pageAfterOut', function (page) {
          informChild(page.name, 'pageAfterOut');
        });
      }, 1);
    }
  }]);

  return _class;
}();
});
$_mod.remap("/marko$4.19.8/dist/runtime/components/beginComponent", "/marko$4.19.8/dist/runtime/components/beginComponent-browser");
$_mod.def("/marko$4.19.8/dist/runtime/components/beginComponent-browser", function(require, exports, module, __filename, __dirname) { var ComponentDef = require('/marko$4.19.8/dist/runtime/components/ComponentDef'/*"./ComponentDef"*/);

module.exports = function beginComponent(componentsContext, component, key, ownerComponentDef) {
  var componentId = component.id;
  var componentDef = componentsContext._N_ = new ComponentDef(component, componentId, componentsContext);
  componentsContext.j_._S_[componentId] = true;
  componentsContext.h_.push(componentDef);

  var out = componentsContext.B_;
  out.bc(component, key, ownerComponentDef && ownerComponentDef.m_);
  return componentDef;
};
});
$_mod.remap("/marko$4.19.8/dist/runtime/components/endComponent", "/marko$4.19.8/dist/runtime/components/endComponent-browser");
$_mod.def("/marko$4.19.8/dist/runtime/components/endComponent-browser", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function endComponent(out) {
  out.ee(); // endElement() (also works for VComponent nodes pushed on to the stack)
};
});
$_mod.def("/marko$4.19.8/dist/runtime/components/renderer", function(require, exports, module, __filename, __dirname) { var componentsUtil = require('/marko$4.19.8/dist/runtime/components/util-browser'/*"./util"*/);
var componentLookup = componentsUtil.F_;
var emitLifecycleEvent = componentsUtil.G_;

var ComponentsContext = require('/marko$4.19.8/dist/runtime/components/ComponentsContext'/*"./ComponentsContext"*/);
var getComponentsContext = ComponentsContext.r_;
var registry = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"./registry"*/);
var copyProps = require('/raptor-util$3.2.0/copyProps'/*"raptor-util/copyProps"*/);
var isServer = componentsUtil.aC_ === true;
var beginComponent = require('/marko$4.19.8/dist/runtime/components/beginComponent-browser'/*"./beginComponent"*/);
var endComponent = require('/marko$4.19.8/dist/runtime/components/endComponent-browser'/*"./endComponent"*/);

var COMPONENT_BEGIN_ASYNC_ADDED_KEY = "$wa";

function resolveComponentKey(key, parentComponentDef) {
  if (key[0] === "#") {
    return key.substring(1);
  } else {
    return parentComponentDef.id + "-" + parentComponentDef._I_(key);
  }
}

function trackAsyncComponents(out) {
  if (out.isSync() || out.global[COMPONENT_BEGIN_ASYNC_ADDED_KEY]) {
    return;
  }

  out.on("beginAsync", handleBeginAsync);
  out.on("beginDetachedAsync", handleBeginDetachedAsync);
  out.global[COMPONENT_BEGIN_ASYNC_ADDED_KEY] = true;
}

function handleBeginAsync(event) {
  var parentOut = event.parentOut;
  var asyncOut = event.out;
  var componentsContext = parentOut.h_;

  if (componentsContext !== undefined) {
    // We are going to start a nested ComponentsContext
    asyncOut.h_ = new ComponentsContext(asyncOut, componentsContext);
  }
  // Carry along the component arguments
  asyncOut.c(parentOut.l_, parentOut.n_, parentOut.aB_);
}

function handleBeginDetachedAsync(event) {
  var asyncOut = event.out;
  handleBeginAsync(event);
  asyncOut.on("beginAsync", handleBeginAsync);
  asyncOut.on("beginDetachedAsync", handleBeginDetachedAsync);
}

function createRendererFunc(templateRenderFunc, componentProps, renderingLogic) {
  renderingLogic = renderingLogic || {};
  var onInput = renderingLogic.onInput;
  var typeName = componentProps.e_;
  var isSplit = componentProps.c_ === true;
  var isImplicitComponent = componentProps.d_ === true;

  var shouldApplySplitMixins = isSplit;

  return function renderer(input, out) {
    trackAsyncComponents(out);

    var componentsContext = getComponentsContext(out);
    var globalComponentsContext = componentsContext.j_;

    var component = globalComponentsContext._t_;
    var isRerender = component !== undefined;
    var id;
    var isExisting;
    var customEvents;
    var parentComponentDef = componentsContext._N_;
    var ownerComponentDef = out.l_;
    var ownerComponentId = ownerComponentDef && ownerComponentDef.id;
    var key = out.n_;

    if (component) {
      // If component is provided then we are currently rendering
      // the top-level UI component as part of a re-render
      id = component.id; // We will use the ID of the component being re-rendered
      isExisting = true; // This is a re-render so we know the component is already in the DOM
      globalComponentsContext._t_ = null;
    } else {
      // Otherwise, we are rendering a nested UI component. We will need
      // to match up the UI component with the component already in the
      // DOM (if any) so we will need to resolve the component ID from
      // the assigned key. We also need to handle any custom event bindings
      // that were provided.
      if (parentComponentDef) {
        // console.log('componentArgs:', componentArgs);
        customEvents = out.aB_;

        if (key != null) {
          id = resolveComponentKey(key.toString(), parentComponentDef);
        } else {
          id = parentComponentDef._J_();
        }
      } else {
        id = globalComponentsContext._J_();
      }
    }

    if (isServer) {
      // If we are rendering on the server then things are simplier since
      // we don't need to match up the UI component with a previously
      // rendered component already mounted to the DOM. We also create
      // a lightweight ServerComponent
      component = registry._L_(renderingLogic, id, input, out, typeName, customEvents, ownerComponentId);

      // This is the final input after running the lifecycle methods.
      // We will be passing the input to the template for the `input` param
      input = component._V_;
    } else {
      if (!component) {
        if (isRerender && (component = componentLookup[id]) && component.e_ !== typeName) {
          // Destroy the existing component since
          component.destroy();
          component = undefined;
        }

        if (component) {
          isExisting = true;
        } else {
          isExisting = false;
          // We need to create a new instance of the component
          component = registry._L_(typeName, id);

          if (shouldApplySplitMixins === true) {
            shouldApplySplitMixins = false;

            var renderingLogicProps = typeof renderingLogic == "function" ? renderingLogic.prototype : renderingLogic;

            copyProps(renderingLogicProps, component.constructor.prototype);
          }
        }

        // Set this flag to prevent the component from being queued for update
        // based on the new input. The component is about to be rerendered
        // so we don't want to queue it up as a result of calling `setInput()`
        component.X_ = true;

        if (customEvents !== undefined) {
          component._x_(customEvents, ownerComponentId);
        }

        if (isExisting === false) {
          emitLifecycleEvent(component, "create", input, out);
        }

        input = component._j_(input, onInput, out);

        if (isExisting === true) {
          if (component._m_ === false || component.shouldUpdate(input, component.M_) === false) {
            // We put a placeholder element in the output stream to ensure that the existing
            // DOM node is matched up correctly when using morphdom. We flag the VElement
            // node to track that it is a preserve marker
            out.aE_(component);
            globalComponentsContext._S_[id] = true;
            component.L_(); // The component is no longer dirty so reset internal flags
            return;
          }
        }
      }

      component.V_ = out.global;

      emitLifecycleEvent(component, "render", out);
    }

    var componentDef = beginComponent(componentsContext, component, key, ownerComponentDef, isSplit, isImplicitComponent);

    componentDef._E_ = isExisting;

    // Render the template associated with the component using the final template
    // data that we constructed
    templateRenderFunc(input, out, componentDef, component, component._v_);

    endComponent(out, componentDef);
    componentsContext._N_ = parentComponentDef;
  };
}

module.exports = createRendererFunc;

// exports used by the legacy renderer
createRendererFunc.ao_ = resolveComponentKey;
createRendererFunc.aA_ = trackAsyncComponents;
});
$_mod.main("/app$1.0.0/src/routes/mobile/routes/home-page", "index.marko");

$_mod.main("/app$1.0.0/src/routes/mobile/routes/home-page/components/home-data-view", "index.marko");
$_mod.def("/marko$4.19.8/dist/runtime/vdom/helpers/v-element", function(require, exports, module, __filename, __dirname) { "use strict";

var VElement = require('/marko$4.19.8/dist/runtime/vdom/vdom'/*"../vdom"*/).aX_;

module.exports = function (tagName, attrs, key, component, childCount, flags, props) {
  return new VElement(tagName, attrs, key, component, childCount, flags, props);
};
});
$_mod.def("/marko$4.19.8/dist/runtime/vdom/helpers/const", function(require, exports, module, __filename, __dirname) { "use strict";

module.exports = function (id) {
  var i = 0;
  return function () {
    return id + i++;
  };
};
});
$_mod.def("/app$1.0.0/src/routes/mobile/routes/home-page/components/home-data-view/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.19.8 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.19.8/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_registry_browser = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"marko/dist/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/home-page/components/home-data-view/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = require('/marko$4.19.8/dist/runtime/components/renderer'/*"marko/dist/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"marko/dist/runtime/components/defineComponent"*/),
    marko_createElement = require('/marko$4.19.8/dist/runtime/vdom/helpers/v-element'/*"marko/dist/runtime/vdom/helpers/v-element"*/),
    marko_const = require('/marko$4.19.8/dist/runtime/vdom/helpers/const'/*"marko/dist/runtime/vdom/helpers/const"*/),
    marko_const_nextId = marko_const("f9aa8b"),
    marko_node0 = marko_createElement("div", {
        "class": "block"
      }, "0", null, 4, 0, {
        i: marko_const_nextId()
      })
      .e("div", {
          "class": "card data-table"
        }, null, null, 1)
        .e("table", null, null, null, 2)
          .e("thead", null, null, null, 1)
            .e("tr", null, null, null, 3)
              .e("th", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("State ")
              .e("th", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("Division")
              .e("th", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("District Name")
          .e("tbody", null, null, null, 1)
            .e("tr", null, null, null, 3)
              .e("td", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("Delhi")
              .e("td", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("Delhi West")
              .e("td", {
                  "class": "label-cell"
                }, null, null, 0)
      .e("div", {
          "class": "card data-table"
        }, null, null, 1)
        .e("table", null, null, null, 2)
          .e("thead", null, null, null, 1)
            .e("tr", null, null, null, 3)
              .e("th", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("Confirmed")
              .e("th", {
                  "class": "numeric-cell"
                }, null, null, 1)
                .t("Deaths")
              .e("th", {
                  "class": "numeric-cell"
                }, null, null, 1)
                .t("Recovered")
          .e("tbody", null, null, null, 1)
            .e("tr", null, null, null, 3)
              .e("td", {
                  "class": "label-cell"
                }, null, null, 1)
                .t("400")
              .e("td", {
                  "class": "numeric-cell"
                }, null, null, 1)
                .t("6")
              .e("td", {
                  "class": "numeric-cell"
                }, null, null, 1)
                .t("5")
      .e("div", {
          "class": "block block-strong"
        }, null, null, 2)
        .e("p", null, null, null, 2)
          .t("Load on Medical Facility ")
          .e("a", {
              href: "#",
              "class": "link tooltip-init profile-link",
              "data-tooltip": "What does this mean"
            }, null, null, 1)
            .t("\"?\"")
        .e("div", null, null, null, 2)
          .e("p", null, null, null, 1)
            .e("div", {
                "data-progress": "10",
                style: "height: 1em;",
                "class": "progressbar color-blue",
                id: "demo-inline-progressbar"
              }, null, null, 0)
          .e("p", {
              "class": "segmented segmented-raised"
            }, null, null, 1)
            .e("a", {
                href: "#",
                "data-progress": "10",
                "class": "button set-inline-progress color-blue"
              }, null, null, 1)
              .t("10%")
      .e("div", {
          "class": "block block-strong"
        }, null, null, 2)
        .e("p", null, null, null, 2)
          .t("Load on Civil Facility ")
          .e("a", {
              href: "#",
              "class": "link tooltip-init profile-link",
              "data-tooltip": "What does this mean"
            }, null, null, 1)
            .t("\"?\"")
        .e("div", null, null, null, 2)
          .e("p", null, null, null, 1)
            .e("div", {
                "data-progress": "90",
                style: "height: 1em;",
                "class": "progressbar color-red",
                id: "demo-inline-progressbar"
              }, null, null, 0)
          .e("p", {
              "class": "segmented segmented-raised"
            }, null, null, 1)
            .e("a", {
                href: "#",
                "data-progress": "100",
                "class": "button set-inline-progress color-red"
              }, null, null, 1)
              .t("90%");

function render(input, out, __component, component, state) {
  var data = input;

  out.n(marko_node0, component);
}

marko_template._ = marko_renderer(render, {
    d_: true,
    e_: marko_componentType
  });

marko_template.Component = marko_defineComponent({}, marko_template._);

});
$_mod.def("/marko$4.19.8/dist/runtime/helpers/load-tag", function(require, exports, module, __filename, __dirname) { "use strict";

/**
 * Helper to load a custom tag
 */

module.exports = function loadTagHelper(renderer) {
  if (renderer) {
    renderer = resolveRenderer(renderer);
  }

  return function wrappedRenderer(input, out, componentDef, key, customEvents) {
    out.c(componentDef, key, customEvents);
    renderer(input, out);
    out.l_ = null;
  };
};

function createDeferredRenderer(handler) {
  function deferredRenderer(input, out) {
    deferredRenderer.renderer(input, out);
  }

  // This is the initial function that will do the rendering. We replace
  // the renderer with the actual renderer func on the first render
  deferredRenderer.renderer = function (input, out) {
    var rendererFunc = handler.renderer || handler._ || handler.render;
    if (typeof rendererFunc !== "function") {
      throw Error("Invalid renderer");
    }
    // Use the actual renderer from now on
    deferredRenderer.renderer = rendererFunc;
    rendererFunc(input, out);
  };

  return deferredRenderer;
}

function resolveRenderer(handler) {
  var renderer = handler.renderer || handler._;

  if (renderer) {
    return renderer;
  }

  if (typeof handler === "function") {
    return handler;
  }

  // If the user code has a circular function then the renderer function
  // may not be available on the module. Since we can't get a reference
  // to the actual renderer(input, out) function right now we lazily
  // try to get access to it later.
  return createDeferredRenderer(handler);
}
});
$_mod.def("/app$1.0.0/src/routes/mobile/routes/home-page/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.19.8 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.19.8/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_registry_browser = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"marko/dist/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/home-page/index.marko", function() {
      return module.exports;
    }),
    marko_renderer = require('/marko$4.19.8/dist/runtime/components/renderer'/*"marko/dist/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"marko/dist/runtime/components/defineComponent"*/),
    home_data_view_template = require('/app$1.0.0/src/routes/mobile/routes/home-page/components/home-data-view/index.marko'/*"./components/home-data-view"*/),
    marko_loadTag = require('/marko$4.19.8/dist/runtime/helpers/load-tag'/*"marko/dist/runtime/helpers/load-tag"*/),
    home_data_view_tag = marko_loadTag(home_data_view_template),
    marko_attrs0 = {
        id: "home-page",
        "data-name": "home-page",
        "class": "page"
      },
    marko_createElement = require('/marko$4.19.8/dist/runtime/vdom/helpers/v-element'/*"marko/dist/runtime/vdom/helpers/v-element"*/),
    marko_const = require('/marko$4.19.8/dist/runtime/vdom/helpers/const'/*"marko/dist/runtime/vdom/helpers/const"*/),
    marko_const_nextId = marko_const("fd1f5c"),
    marko_node0 = marko_createElement("div", {
        "class": "navbar"
      }, "1", null, 1, 0, {
        i: marko_const_nextId()
      })
      .e("div", {
          "class": "navbar-inner sliding"
        }, null, null, 1)
        .e("div", {
            "class": "title"
          }, null, null, 1)
          .t("Home "),
    marko_attrs1 = {
        "class": "page-content"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.be("div", marko_attrs0, "0", component);

  out.n(marko_node0, component);

  out.t(" > ");

  out.be("div", marko_attrs1, "4", component);

  home_data_view_tag({}, out, __component, "5");

  out.ee();

  out.ee();
}

marko_template._ = marko_renderer(render, {
    d_: true,
    e_: marko_componentType
  });

marko_template.Component = marko_defineComponent({}, marko_template._);

});
$_mod.main("/app$1.0.0/src/routes/mobile/routes/login-page", "index.marko");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/component", function(require, exports, module, __filename, __dirname) { var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

module.exports = function () {
  function _class() {
    _classCallCheck(this, _class);
  }

  _createClass(_class, [{
    key: "onCreate",
    value: function onCreate() {}
  }, {
    key: "login_success",
    value: function login_success() {
      window.app.views && window.app.views.main.router.navigate({
        name: "home-page"
      });
    }
  }]);

  return _class;
}();
});
$_mod.main("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form", "index.marko");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/component", function(require, exports, module, __filename, __dirname) { var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

module.exports = function () {
  function _class() {
    _classCallCheck(this, _class);
  }

  _createClass(_class, [{
    key: 'signIn',
    value: function signIn() {
      window.app.data.pincode = this.getEl('pincode').value;
      this.emit('login');
    }
  }]);

  return _class;
}();
});
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.19.8 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.19.8/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_registry_browser = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"marko/dist/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/component'/*"./component"*/),
    marko_renderer = require('/marko$4.19.8/dist/runtime/components/renderer'/*"marko/dist/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"marko/dist/runtime/components/defineComponent"*/),
    marko_attrs0 = {
        action: "javascript:void(0);"
      },
    marko_createElement = require('/marko$4.19.8/dist/runtime/vdom/helpers/v-element'/*"marko/dist/runtime/vdom/helpers/v-element"*/),
    marko_const = require('/marko$4.19.8/dist/runtime/vdom/helpers/const'/*"marko/dist/runtime/vdom/helpers/const"*/),
    marko_const_nextId = marko_const("5cb30b"),
    marko_node0 = marko_createElement("div", {
        "class": "list no-hairlines-md"
      }, "1", null, 1, 0, {
        i: marko_const_nextId()
      })
      .e("ul", null, null, null, 1)
        .e("li", {
            "class": "item-content item-input item-input-with-info"
          }, null, null, 1)
          .e("div", {
              "class": "item-inner"
            }, null, null, 2)
            .e("div", {
                "class": "item-title item-label"
              }, null, null, 1)
              .t("Pincode")
            .e("div", {
                "class": "item-input-wrap"
              }, null, null, 3)
              .e("input", {
                  type: "number",
                  name: "pincode",
                  placeholder: "110027",
                  required: true
                }, "@pincode", null, 0)
              .e("span", {
                  "class": "input-clear-button"
                }, null, null, 0)
              .e("div", {
                  "class": "item-input-info"
                }, null, null, 1)
                .t("your India Pincode"),
    marko_attrs1 = {
        "class": "list"
      },
    marko_attrs2 = {
        id: "login-button",
        "class": "item-link list-button",
        disabled: true,
        href: "#"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.e("form", marko_attrs0, "0", component, 2)
    .n(marko_node0, component)
    .e("div", marko_attrs1, "9", component, 1)
      .e("ul", null, "10", component, 1)
        .e("li", null, "11", component, 1)
          .e("a", marko_attrs2, "12", component, 1, 0, {
              onclick: __component.d("click", "signIn", false)
            })
            .t("Submit");
}

marko_template._ = marko_renderer(render, {
    e_: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.19.8 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.19.8/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_registry_browser = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"marko/dist/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/routes/login-page/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/app$1.0.0/src/routes/mobile/routes/login-page/component'/*"./component"*/),
    marko_renderer = require('/marko$4.19.8/dist/runtime/components/renderer'/*"marko/dist/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"marko/dist/runtime/components/defineComponent"*/),
    login_form_template = require('/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko'/*"./components/login-form"*/),
    marko_loadTag = require('/marko$4.19.8/dist/runtime/helpers/load-tag'/*"marko/dist/runtime/helpers/load-tag"*/),
    login_form_tag = marko_loadTag(login_form_template),
    marko_attrs0 = {
        id: "login",
        "data-name": "login",
        "class": "page "
      },
    marko_createElement = require('/marko$4.19.8/dist/runtime/vdom/helpers/v-element'/*"marko/dist/runtime/vdom/helpers/v-element"*/),
    marko_const = require('/marko$4.19.8/dist/runtime/vdom/helpers/const'/*"marko/dist/runtime/vdom/helpers/const"*/),
    marko_const_nextId = marko_const("6d620a"),
    marko_node0 = marko_createElement("div", {
        "class": "navbar"
      }, "1", null, 1, 0, {
        i: marko_const_nextId()
      })
      .e("div", {
          "class": "navbar-inner sliding"
        }, null, null, 1)
        .e("div", {
            "class": "title"
          }, null, null, 1)
          .t("Login"),
    marko_attrs1 = {
        "class": "page-content"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.be("div", marko_attrs0, "0", component);

  out.n(marko_node0, component);

  out.be("div", marko_attrs1, "4", component);

  login_form_tag({}, out, __component, "5", [
    [
      "login",
      "login_success",
      false
    ]
  ]);

  out.ee();

  out.ee();
}

marko_template._ = marko_renderer(render, {
    e_: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/index.marko", function(require, exports, module, __filename, __dirname) { // Compiled using marko@4.19.8 - DO NOT EDIT
"use strict";

var marko_template = module.exports = require('/marko$4.19.8/dist/vdom'/*"marko/dist/vdom"*/).t(),
    components_registry_browser = require('/marko$4.19.8/dist/runtime/components/registry-browser'/*"marko/dist/runtime/components/registry-browser"*/),
    marko_registerComponent = components_registry_browser.r,
    marko_componentType = marko_registerComponent("/app$1.0.0/src/routes/mobile/components/app/index.marko", function() {
      return module.exports;
    }),
    marko_component = require('/app$1.0.0/src/routes/mobile/components/app/component'/*"./component"*/),
    marko_renderer = require('/marko$4.19.8/dist/runtime/components/renderer'/*"marko/dist/runtime/components/renderer"*/),
    marko_defineComponent = require('/marko$4.19.8/dist/runtime/components/defineComponent'/*"marko/dist/runtime/components/defineComponent"*/),
    home_page_template = require('/app$1.0.0/src/routes/mobile/routes/home-page/index.marko'/*"../../routes/home-page"*/),
    marko_loadTag = require('/marko$4.19.8/dist/runtime/helpers/load-tag'/*"marko/dist/runtime/helpers/load-tag"*/),
    home_page_tag = marko_loadTag(home_page_template),
    login_page_template = require('/app$1.0.0/src/routes/mobile/routes/login-page/index.marko'/*"../../routes/login-page"*/),
    login_page_tag = marko_loadTag(login_page_template),
    marko_attrs0 = {
        id: "app"
      },
    marko_createElement = require('/marko$4.19.8/dist/runtime/vdom/helpers/v-element'/*"marko/dist/runtime/vdom/helpers/v-element"*/),
    marko_const = require('/marko$4.19.8/dist/runtime/vdom/helpers/const'/*"marko/dist/runtime/vdom/helpers/const"*/),
    marko_const_nextId = marko_const("8f4421"),
    marko_node0 = marko_createElement("div", {
        "class": "statusbar"
      }, "1", null, 0, 0, {
        i: marko_const_nextId()
      }),
    marko_attrs1 = {
        "class": "view view-main"
      };

function render(input, out, __component, component, state) {
  var data = input;

  out.be("div", marko_attrs0, "0", component);

  out.n(marko_node0, component);

  out.be("div", marko_attrs1, "2", component);

  home_page_tag({}, out, __component, "home");

  login_page_tag({}, out, __component, "login");

  out.ee();

  out.ee();
}

marko_template._ = marko_renderer(render, {
    e_: marko_componentType
  }, marko_component);

marko_template.Component = marko_defineComponent(marko_component, marko_template._);

});
$_mod.def("/app$1.0.0/src/routes/mobile/components/app/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.19.8/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/routes/mobile/components/app/index.marko", require('/app$1.0.0/src/routes/mobile/components/app/index.marko'/*"./"*/));
});
$_mod.run("/app$1.0.0/src/routes/mobile/components/app/index.marko.register");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.19.8/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/routes/mobile/routes/login-page/index.marko", require('/app$1.0.0/src/routes/mobile/routes/login-page/index.marko'/*"./"*/));
});
$_mod.run("/app$1.0.0/src/routes/mobile/routes/login-page/index.marko.register");
$_mod.def("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko.register", function(require, exports, module, __filename, __dirname) { require('/marko$4.19.8/components-browser.marko'/*'marko/components'*/).register("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko", require('/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko'/*"./"*/));
});
$_mod.run("/app$1.0.0/src/routes/mobile/routes/login-page/components/login-form/index.marko.register");
/**
 * Framework7 4.5.2
 * Full featured mobile HTML framework for building iOS & Android apps
 * http://framework7.io/
 *
 * Copyright 2014-2019 Vladimir Kharlampidi
 *
 * Released under the MIT License
 *
 * Released on: September 27, 2019
 */

!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?module.exports=t():"function"==typeof define&&define.amd?define(t):(e=e||self).Framework7=t()}(this,function(){"use strict";var t7ctx;t7ctx="undefined"!=typeof window?window:"undefined"!=typeof global?global:void 0;var Template7Context=t7ctx,Template7Utils={quoteSingleRexExp:new RegExp("'","g"),quoteDoubleRexExp:new RegExp('"',"g"),isFunction:function(e){return"function"==typeof e},escape:function(e){return void 0===e&&(e=""),e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;")},helperToSlices:function(e){var t,a,r,i=Template7Utils.quoteDoubleRexExp,n=Template7Utils.quoteSingleRexExp,s=e.replace(/[{}#}]/g,"").trim().split(" "),o=[];for(a=0;a<s.length;a+=1){var l=s[a],p=void 0,c=void 0;if(0===a)o.push(l);else if(0===l.indexOf('"')||0===l.indexOf("'"))if(p=0===l.indexOf('"')?i:n,c=0===l.indexOf('"')?'"':"'",2===l.match(p).length)o.push(l);else{for(t=0,r=a+1;r<s.length;r+=1)if(l+=" "+s[r],s[r].indexOf(c)>=0){t=r,o.push(l);break}t&&(a=t)}else if(l.indexOf("=")>0){var d=l.split("="),u=d[0],h=d[1];if(p||(p=0===h.indexOf('"')?i:n,c=0===h.indexOf('"')?'"':"'"),2!==h.match(p).length){for(t=0,r=a+1;r<s.length;r+=1)if(h+=" "+s[r],s[r].indexOf(c)>=0){t=r;break}t&&(a=t)}var f=[u,h.replace(p,"")];o.push(f)}else o.push(l)}return o},stringToBlocks:function(e){var t,a,r=[];if(!e)return[];var i=e.split(/({{[^{^}]*}})/);for(t=0;t<i.length;t+=1){var n=i[t];if(""!==n)if(n.indexOf("{{")<0)r.push({type:"plain",content:n});else{if(n.indexOf("{/")>=0)continue;if((n=n.replace(/{{([#\/])*([ ])*/,"{{$1").replace(/([ ])*}}/,"}}")).indexOf("{#")<0&&n.indexOf(" ")<0&&n.indexOf("else")<0){r.push({type:"variable",contextName:n.replace(/[{}]/g,"")});continue}var s=Template7Utils.helperToSlices(n),o=s[0],l=">"===o,p=[],c={};for(a=1;a<s.length;a+=1){var d=s[a];Array.isArray(d)?c[d[0]]="false"!==d[1]&&d[1]:p.push(d)}if(n.indexOf("{#")>=0){var u="",h="",f=0,v=void 0,m=!1,g=!1,b=0;for(a=t+1;a<i.length;a+=1)if(i[a].indexOf("{{#")>=0&&(b+=1),i[a].indexOf("{{/")>=0&&(b-=1),i[a].indexOf("{{#"+o)>=0)u+=i[a],g&&(h+=i[a]),f+=1;else if(i[a].indexOf("{{/"+o)>=0){if(!(f>0)){v=a,m=!0;break}f-=1,u+=i[a],g&&(h+=i[a])}else i[a].indexOf("else")>=0&&0===b?g=!0:(g||(u+=i[a]),g&&(h+=i[a]));m&&(v&&(t=v),"raw"===o?r.push({type:"plain",content:u}):r.push({type:"helper",helperName:o,contextName:p,content:u,inverseContent:h,hash:c}))}else n.indexOf(" ")>0&&(l&&(o="_partial",p[0]&&(0===p[0].indexOf("[")?p[0]=p[0].replace(/[[\]]/g,""):p[0]='"'+p[0].replace(/"|'/g,"")+'"')),r.push({type:"helper",helperName:o,contextName:p,hash:c}))}}return r},parseJsVariable:function(e,t,a){return e.split(/([+ \-*\/^()&=|<>!%:?])/g).reduce(function(e,r){if(!r)return e;if(r.indexOf(t)<0)return e.push(r),e;if(!a)return e.push(JSON.stringify("")),e;var i=a;return r.indexOf(t+".")>=0&&r.split(t+".")[1].split(".").forEach(function(e){i=e in i?i[e]:void 0}),("string"==typeof i||Array.isArray(i)||i.constructor&&i.constructor===Object)&&(i=JSON.stringify(i)),void 0===i&&(i="undefined"),e.push(i),e},[]).join("")},parseJsParents:function(e,t){return e.split(/([+ \-*^()&=|<>!%:?])/g).reduce(function(e,a){if(!a)return e;if(a.indexOf("../")<0)return e.push(a),e;if(!t||0===t.length)return e.push(JSON.stringify("")),e;var r=a.split("../").length-1,i=r>t.length?t[t.length-1]:t[r-1];return a.replace(/..\//g,"").split(".").forEach(function(e){i=void 0!==i[e]?i[e]:"undefined"}),!1===i||!0===i?(e.push(JSON.stringify(i)),e):null===i||"undefined"===i?(e.push(JSON.stringify("")),e):(e.push(JSON.stringify(i)),e)},[]).join("")},getCompileVar:function(e,t,a){void 0===a&&(a="data_1");var r,i,n=t,s=0;0===e.indexOf("../")?(s=e.split("../").length-1,i=n.split("_")[1]-s,n="ctx_"+(i>=1?i:1),r=e.split("../")[s].split(".")):0===e.indexOf("@global")?(n="Template7.global",r=e.split("@global.")[1].split(".")):0===e.indexOf("@root")?(n="root",r=e.split("@root.")[1].split(".")):r=e.split(".");for(var o=0;o<r.length;o+=1){var l=r[o];if(0===l.indexOf("@")){var p=a.split("_")[1];s>0&&(p=i),o>0?n+="[(data_"+p+" && data_"+p+"."+l.replace("@","")+")]":n="(data_"+p+" && data_"+p+"."+l.replace("@","")+")"}else(Number.isFinite?Number.isFinite(l):Template7Context.isFinite(l))?n+="["+l+"]":"this"===l||l.indexOf("this.")>=0||l.indexOf("this[")>=0||l.indexOf("this(")>=0?n=l.replace("this",t):n+="."+l}return n},getCompiledArguments:function(e,t,a){for(var r=[],i=0;i<e.length;i+=1)/^['"]/.test(e[i])?r.push(e[i]):/^(true|false|\d+)$/.test(e[i])?r.push(e[i]):r.push(Template7Utils.getCompileVar(e[i],t,a));return r.join(", ")}},Template7Helpers={_partial:function(e,t){var a=this,r=Template7Class.partials[e];return!r||r&&!r.template?"":(r.compiled||(r.compiled=new Template7Class(r.template).compile()),Object.keys(t.hash).forEach(function(e){a[e]=t.hash[e]}),r.compiled(a,t.data,t.root))},escape:function(e){if(null==e)return"";if("string"!=typeof e)throw new Error('Template7: Passed context to "escape" helper should be a string');return Template7Utils.escape(e)},if:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a?t.fn(this,t.data):t.inverse(this,t.data)},unless:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a?t.inverse(this,t.data):t.fn(this,t.data)},each:function(e,t){var a=e,r="",i=0;if(Template7Utils.isFunction(a)&&(a=a.call(this)),Array.isArray(a)){for(t.hash.reverse&&(a=a.reverse()),i=0;i<a.length;i+=1)r+=t.fn(a[i],{first:0===i,last:i===a.length-1,index:i});t.hash.reverse&&(a=a.reverse())}else for(var n in a)i+=1,r+=t.fn(a[n],{key:n});return i>0?r:t.inverse(this)},with:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=e.call(this)),t.fn(a)},join:function(e,t){var a=e;return Template7Utils.isFunction(a)&&(a=a.call(this)),a.join(t.hash.delimiter||t.hash.delimeter)},js:function js(expression,options){var data=options.data,func,execute=expression;return"index first last key".split(" ").forEach(function(e){if(void 0!==data[e]){var t=new RegExp("this.@"+e,"g"),a=new RegExp("@"+e,"g");execute=execute.replace(t,JSON.stringify(data[e])).replace(a,JSON.stringify(data[e]))}}),options.root&&execute.indexOf("@root")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@root",options.root)),execute.indexOf("@global")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@global",Template7Context.Template7.global)),execute.indexOf("../")>=0&&(execute=Template7Utils.parseJsParents(execute,options.parents)),func=execute.indexOf("return")>=0?"(function(){"+execute+"})":"(function(){return ("+execute+")})",eval(func).call(this)},js_if:function js_if(expression,options){var data=options.data,func,execute=expression;"index first last key".split(" ").forEach(function(e){if(void 0!==data[e]){var t=new RegExp("this.@"+e,"g"),a=new RegExp("@"+e,"g");execute=execute.replace(t,JSON.stringify(data[e])).replace(a,JSON.stringify(data[e]))}}),options.root&&execute.indexOf("@root")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@root",options.root)),execute.indexOf("@global")>=0&&(execute=Template7Utils.parseJsVariable(execute,"@global",Template7Context.Template7.global)),execute.indexOf("../")>=0&&(execute=Template7Utils.parseJsParents(execute,options.parents)),func=execute.indexOf("return")>=0?"(function(){"+execute+"})":"(function(){return ("+execute+")})";var condition=eval(func).call(this);return condition?options.fn(this,options.data):options.inverse(this,options.data)}};Template7Helpers.js_compare=Template7Helpers.js_if;var Template7Options={},Template7Partials={},Template7Class=function(e){this.template=e},staticAccessors={options:{configurable:!0},partials:{configurable:!0},helpers:{configurable:!0}};function Template7(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a=e[0],r=e[1];if(2===e.length){var i=new Template7Class(a),n=i.compile()(r);return i=null,n}return new Template7Class(a)}Template7Class.prototype.compile=function compile(template,depth){void 0===template&&(template=this.template),void 0===depth&&(depth=1);var t=this;if(t.compiled)return t.compiled;if("string"!=typeof template)throw new Error("Template7: Template must be a string");var stringToBlocks=Template7Utils.stringToBlocks,getCompileVar=Template7Utils.getCompileVar,getCompiledArguments=Template7Utils.getCompiledArguments,blocks=stringToBlocks(template),ctx="ctx_"+depth,data="data_"+depth;if(0===blocks.length)return function(){return""};function getCompileFn(e,a){return e.content?t.compile(e.content,a):function(){return""}}function getCompileInverse(e,a){return e.inverseContent?t.compile(e.inverseContent,a):function(){return""}}var resultString="",i;for(resultString+=1===depth?"(function ("+ctx+", "+data+", root) {\n":"(function ("+ctx+", "+data+") {\n",1===depth&&(resultString+="function isArray(arr){return Array.isArray(arr);}\n",resultString+="function isFunction(func){return (typeof func === 'function');}\n",resultString+='function c(val, ctx) {if (typeof val !== "undefined" && val !== null) {if (isFunction(val)) {return val.call(ctx);} else return val;} else return "";}\n',resultString+="root = root || ctx_1 || {};\n"),resultString+="var r = '';\n",i=0;i<blocks.length;i+=1){var block=blocks[i];if("plain"!==block.type){var variable=void 0,compiledArguments=void 0;if("variable"===block.type&&(variable=getCompileVar(block.contextName,ctx,data),resultString+="r += c("+variable+", "+ctx+");"),"helper"===block.type){var parents=void 0;if("ctx_1"!==ctx){for(var level=ctx.split("_")[1],parentsString="ctx_"+(level-1),j=level-2;j>=1;j-=1)parentsString+=", ctx_"+j;parents="["+parentsString+"]"}else parents="["+ctx+"]";var dynamicHelper=void 0;if(0===block.helperName.indexOf("[")&&(block.helperName=getCompileVar(block.helperName.replace(/[[\]]/g,""),ctx,data),dynamicHelper=!0),dynamicHelper||block.helperName in Template7Helpers)compiledArguments=getCompiledArguments(block.contextName,ctx,data),resultString+="r += (Template7Helpers"+(dynamicHelper?"["+block.helperName+"]":"."+block.helperName)+").call("+ctx+", "+(compiledArguments&&compiledArguments+", ")+"{hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});";else{if(block.contextName.length>0)throw new Error('Template7: Missing helper: "'+block.helperName+'"');variable=getCompileVar(block.helperName,ctx,data),resultString+="if ("+variable+") {",resultString+="if (isArray("+variable+")) {",resultString+="r += (Template7Helpers.each).call("+ctx+", "+variable+", {hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});",resultString+="}else {",resultString+="r += (Template7Helpers.with).call("+ctx+", "+variable+", {hash:"+JSON.stringify(block.hash)+", data: "+data+" || {}, fn: "+getCompileFn(block,depth+1)+", inverse: "+getCompileInverse(block,depth+1)+", root: root, parents: "+parents+"});",resultString+="}}"}}}else resultString+="r +='"+block.content.replace(/\r/g,"\\r").replace(/\n/g,"\\n").replace(/'/g,"\\'")+"';"}return resultString+="\nreturn r;})",1===depth?(t.compiled=eval(resultString),t.compiled):resultString},staticAccessors.options.get=function(){return Template7Options},staticAccessors.partials.get=function(){return Template7Partials},staticAccessors.helpers.get=function(){return Template7Helpers},Object.defineProperties(Template7Class,staticAccessors),Template7.registerHelper=function(e,t){Template7Class.helpers[e]=t},Template7.unregisterHelper=function(e){Template7Class.helpers[e]=void 0,delete Template7Class.helpers[e]},Template7.registerPartial=function(e,t){Template7Class.partials[e]={template:t}},Template7.unregisterPartial=function(e){Template7Class.partials[e]&&(Template7Class.partials[e]=void 0,delete Template7Class.partials[e])},Template7.compile=function(e,t){return new Template7Class(e,t).compile()},Template7.options=Template7Class.options,Template7.helpers=Template7Class.helpers,Template7.partials=Template7Class.partials;var doc="undefined"==typeof document?{body:{},addEventListener:function(){},removeEventListener:function(){},activeElement:{blur:function(){},nodeName:""},querySelector:function(){return null},querySelectorAll:function(){return[]},getElementById:function(){return null},createEvent:function(){return{initEvent:function(){}}},createElement:function(){return{children:[],childNodes:[],style:{},setAttribute:function(){},getElementsByTagName:function(){return[]}}},location:{hash:""}}:document,win="undefined"==typeof window?{document:doc,navigator:{userAgent:""},location:{},history:{},CustomEvent:function(){return this},addEventListener:function(){},removeEventListener:function(){},getComputedStyle:function(){return{getPropertyValue:function(){return""}}},Image:function(){},Date:function(){},screen:{},setTimeout:function(){},clearTimeout:function(){}}:window,Dom7=function(e){for(var t=0;t<e.length;t+=1)this[t]=e[t];return this.length=e.length,this};function $(e,t){var a=[],r=0;if(e&&!t&&e instanceof Dom7)return e;if(e)if("string"==typeof e){var i,n,s=e.trim();if(s.indexOf("<")>=0&&s.indexOf(">")>=0){var o="div";for(0===s.indexOf("<li")&&(o="ul"),0===s.indexOf("<tr")&&(o="tbody"),0!==s.indexOf("<td")&&0!==s.indexOf("<th")||(o="tr"),0===s.indexOf("<tbody")&&(o="table"),0===s.indexOf("<option")&&(o="select"),(n=doc.createElement(o)).innerHTML=s,r=0;r<n.childNodes.length;r+=1)a.push(n.childNodes[r])}else for(i=t||"#"!==e[0]||e.match(/[ .<>:~]/)?(t||doc).querySelectorAll(e.trim()):[doc.getElementById(e.trim().split("#")[1])],r=0;r<i.length;r+=1)i[r]&&a.push(i[r])}else if(e.nodeType||e===win||e===doc)a.push(e);else if(e.length>0&&e[0].nodeType)for(r=0;r<e.length;r+=1)a.push(e[r]);return new Dom7(a)}function unique(e){for(var t=[],a=0;a<e.length;a+=1)-1===t.indexOf(e[a])&&t.push(e[a]);return t}function toCamelCase(e){return e.toLowerCase().replace(/-(.)/g,function(e,t){return t.toUpperCase()})}function requestAnimationFrame(e){return win.requestAnimationFrame?win.requestAnimationFrame(e):win.webkitRequestAnimationFrame?win.webkitRequestAnimationFrame(e):win.setTimeout(e,1e3/60)}function cancelAnimationFrame(e){return win.cancelAnimationFrame?win.cancelAnimationFrame(e):win.webkitCancelAnimationFrame?win.webkitCancelAnimationFrame(e):win.clearTimeout(e)}function addClass(e){if(void 0===e)return this;for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.add(t[a]);return this}function removeClass(e){for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.remove(t[a]);return this}function hasClass(e){return!!this[0]&&this[0].classList.contains(e)}function toggleClass(e){for(var t=e.split(" "),a=0;a<t.length;a+=1)for(var r=0;r<this.length;r+=1)void 0!==this[r]&&void 0!==this[r].classList&&this[r].classList.toggle(t[a]);return this}function attr(e,t){var a=arguments;if(1===arguments.length&&"string"==typeof e)return this[0]?this[0].getAttribute(e):void 0;for(var r=0;r<this.length;r+=1)if(2===a.length)this[r].setAttribute(e,t);else for(var i in e)this[r][i]=e[i],this[r].setAttribute(i,e[i]);return this}function removeAttr(e){for(var t=0;t<this.length;t+=1)this[t].removeAttribute(e);return this}function prop(e,t){var a=arguments;if(1!==arguments.length||"string"!=typeof e){for(var r=0;r<this.length;r+=1)if(2===a.length)this[r][e]=t;else for(var i in e)this[r][i]=e[i];return this}if(this[0])return this[0][e]}function data(e,t){var a;if(void 0!==t){for(var r=0;r<this.length;r+=1)(a=this[r]).dom7ElementDataStorage||(a.dom7ElementDataStorage={}),a.dom7ElementDataStorage[e]=t;return this}if(a=this[0]){if(a.dom7ElementDataStorage&&e in a.dom7ElementDataStorage)return a.dom7ElementDataStorage[e];var i=a.getAttribute("data-"+e);return i||void 0}}function removeData(e){for(var t=0;t<this.length;t+=1){var a=this[t];a.dom7ElementDataStorage&&a.dom7ElementDataStorage[e]&&(a.dom7ElementDataStorage[e]=null,delete a.dom7ElementDataStorage[e])}}function dataset(){var e=this[0];if(e){var t={};if(e.dataset)for(var a in e.dataset)t[a]=e.dataset[a];else for(var r=0;r<e.attributes.length;r+=1){var i=e.attributes[r];i.name.indexOf("data-")>=0&&(t[toCamelCase(i.name.split("data-")[1])]=i.value)}for(var n in t)"false"===t[n]?t[n]=!1:"true"===t[n]?t[n]=!0:parseFloat(t[n])===1*t[n]&&(t[n]*=1);return t}}function val(e){if(void 0!==e){for(var t=0;t<this.length;t+=1){var a=this[t];if(Array.isArray(e)&&a.multiple&&"select"===a.nodeName.toLowerCase())for(var r=0;r<a.options.length;r+=1)a.options[r].selected=e.indexOf(a.options[r].value)>=0;else a.value=e}return this}if(this[0]){if(this[0].multiple&&"select"===this[0].nodeName.toLowerCase()){for(var i=[],n=0;n<this[0].selectedOptions.length;n+=1)i.push(this[0].selectedOptions[n].value);return i}return this[0].value}}function transform(e){for(var t=0;t<this.length;t+=1){var a=this[t].style;a.webkitTransform=e,a.transform=e}return this}function transition(e){"string"!=typeof e&&(e+="ms");for(var t=0;t<this.length;t+=1){var a=this[t].style;a.webkitTransitionDuration=e,a.transitionDuration=e}return this}function on(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2],s=t[3];function o(e){var t=e.target;if(t){var a=e.target.dom7EventData||[];if(a.indexOf(e)<0&&a.unshift(e),$(t).is(i))n.apply(t,a);else for(var r=$(t).parents(),s=0;s<r.length;s+=1)$(r[s]).is(i)&&n.apply(r[s],a)}}function l(e){var t=e&&e.target&&e.target.dom7EventData||[];t.indexOf(e)<0&&t.unshift(e),n.apply(this,t)}"function"==typeof t[1]&&(r=(e=t)[0],n=e[1],s=e[2],i=void 0),s||(s=!1);for(var p,c=r.split(" "),d=0;d<this.length;d+=1){var u=this[d];if(i)for(p=0;p<c.length;p+=1){var h=c[p];u.dom7LiveListeners||(u.dom7LiveListeners={}),u.dom7LiveListeners[h]||(u.dom7LiveListeners[h]=[]),u.dom7LiveListeners[h].push({listener:n,proxyListener:o}),u.addEventListener(h,o,s)}else for(p=0;p<c.length;p+=1){var f=c[p];u.dom7Listeners||(u.dom7Listeners={}),u.dom7Listeners[f]||(u.dom7Listeners[f]=[]),u.dom7Listeners[f].push({listener:n,proxyListener:l}),u.addEventListener(f,l,s)}}return this}function off(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2],s=t[3];"function"==typeof t[1]&&(r=(e=t)[0],n=e[1],s=e[2],i=void 0),s||(s=!1);for(var o=r.split(" "),l=0;l<o.length;l+=1)for(var p=o[l],c=0;c<this.length;c+=1){var d=this[c],u=void 0;if(!i&&d.dom7Listeners?u=d.dom7Listeners[p]:i&&d.dom7LiveListeners&&(u=d.dom7LiveListeners[p]),u&&u.length)for(var h=u.length-1;h>=0;h-=1){var f=u[h];n&&f.listener===n?(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1)):n&&f.listener&&f.listener.dom7proxy&&f.listener.dom7proxy===n?(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1)):n||(d.removeEventListener(p,f.proxyListener,s),u.splice(h,1))}}return this}function once(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=this,i=t[0],n=t[1],s=t[2],o=t[3];function l(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];s.apply(this,e),r.off(i,n,l,o),l.dom7proxy&&delete l.dom7proxy}return"function"==typeof t[1]&&(i=(e=t)[0],s=e[1],o=e[2],n=void 0),l.dom7proxy=s,r.on(i,n,l,o)}function trigger(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];for(var a=e[0].split(" "),r=e[1],i=0;i<a.length;i+=1)for(var n=a[i],s=0;s<this.length;s+=1){var o=this[s],l=void 0;try{l=new win.CustomEvent(n,{detail:r,bubbles:!0,cancelable:!0})}catch(e){(l=doc.createEvent("Event")).initEvent(n,!0,!0),l.detail=r}o.dom7EventData=e.filter(function(e,t){return t>0}),o.dispatchEvent(l),o.dom7EventData=[],delete o.dom7EventData}return this}function transitionEnd(e){var t,a=["webkitTransitionEnd","transitionend"],r=this;function i(n){if(n.target===this)for(e.call(this,n),t=0;t<a.length;t+=1)r.off(a[t],i)}if(e)for(t=0;t<a.length;t+=1)r.on(a[t],i);return this}function animationEnd(e){var t,a=["webkitAnimationEnd","animationend"],r=this;function i(n){if(n.target===this)for(e.call(this,n),t=0;t<a.length;t+=1)r.off(a[t],i)}if(e)for(t=0;t<a.length;t+=1)r.on(a[t],i);return this}function width(){return this[0]===win?win.innerWidth:this.length>0?parseFloat(this.css("width")):null}function outerWidth(e){if(this.length>0){if(e){var t=this.styles();return this[0].offsetWidth+parseFloat(t.getPropertyValue("margin-right"))+parseFloat(t.getPropertyValue("margin-left"))}return this[0].offsetWidth}return null}function height(){return this[0]===win?win.innerHeight:this.length>0?parseFloat(this.css("height")):null}function outerHeight(e){if(this.length>0){if(e){var t=this.styles();return this[0].offsetHeight+parseFloat(t.getPropertyValue("margin-top"))+parseFloat(t.getPropertyValue("margin-bottom"))}return this[0].offsetHeight}return null}function offset(){if(this.length>0){var e=this[0],t=e.getBoundingClientRect(),a=doc.body,r=e.clientTop||a.clientTop||0,i=e.clientLeft||a.clientLeft||0,n=e===win?win.scrollY:e.scrollTop,s=e===win?win.scrollX:e.scrollLeft;return{top:t.top+n-r,left:t.left+s-i}}return null}function hide(){for(var e=0;e<this.length;e+=1)this[e].style.display="none";return this}function show(){for(var e=0;e<this.length;e+=1){var t=this[e];"none"===t.style.display&&(t.style.display=""),"none"===win.getComputedStyle(t,null).getPropertyValue("display")&&(t.style.display="block")}return this}function styles(){return this[0]?win.getComputedStyle(this[0],null):{}}function css(e,t){var a;if(1===arguments.length){if("string"!=typeof e){for(a=0;a<this.length;a+=1)for(var r in e)this[a].style[r]=e[r];return this}if(this[0])return win.getComputedStyle(this[0],null).getPropertyValue(e)}if(2===arguments.length&&"string"==typeof e){for(a=0;a<this.length;a+=1)this[a].style[e]=t;return this}return this}function toArray(){for(var e=[],t=0;t<this.length;t+=1)e.push(this[t]);return e}function each(e){if(!e)return this;for(var t=0;t<this.length;t+=1)if(!1===e.call(this[t],t,this[t]))return this;return this}function forEach(e){if(!e)return this;for(var t=0;t<this.length;t+=1)if(!1===e.call(this[t],this[t],t))return this;return this}function filter(e){for(var t=[],a=0;a<this.length;a+=1)e.call(this[a],a,this[a])&&t.push(this[a]);return new Dom7(t)}function map(e){for(var t=[],a=0;a<this.length;a+=1)t.push(e.call(this[a],a,this[a]));return new Dom7(t)}function html(e){if(void 0===e)return this[0]?this[0].innerHTML:void 0;for(var t=0;t<this.length;t+=1)this[t].innerHTML=e;return this}function text(e){if(void 0===e)return this[0]?this[0].textContent.trim():null;for(var t=0;t<this.length;t+=1)this[t].textContent=e;return this}function is(e){var t,a,r=this[0];if(!r||void 0===e)return!1;if("string"==typeof e){if(r.matches)return r.matches(e);if(r.webkitMatchesSelector)return r.webkitMatchesSelector(e);if(r.msMatchesSelector)return r.msMatchesSelector(e);for(t=$(e),a=0;a<t.length;a+=1)if(t[a]===r)return!0;return!1}if(e===doc)return r===doc;if(e===win)return r===win;if(e.nodeType||e instanceof Dom7){for(t=e.nodeType?[e]:e,a=0;a<t.length;a+=1)if(t[a]===r)return!0;return!1}return!1}function indexOf(e){for(var t=0;t<this.length;t+=1)if(this[t]===e)return t;return-1}function index(){var e,t=this[0];if(t){for(e=0;null!==(t=t.previousSibling);)1===t.nodeType&&(e+=1);return e}}function eq(e){if(void 0===e)return this;var t,a=this.length;return new Dom7(e>a-1?[]:e<0?(t=a+e)<0?[]:[this[t]]:[this[e]])}function append(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];for(var r=0;r<t.length;r+=1){e=t[r];for(var i=0;i<this.length;i+=1)if("string"==typeof e){var n=doc.createElement("div");for(n.innerHTML=e;n.firstChild;)this[i].appendChild(n.firstChild)}else if(e instanceof Dom7)for(var s=0;s<e.length;s+=1)this[i].appendChild(e[s]);else this[i].appendChild(e)}return this}function appendTo(e){return $(e).append(this),this}function prepend(e){var t,a;for(t=0;t<this.length;t+=1)if("string"==typeof e){var r=doc.createElement("div");for(r.innerHTML=e,a=r.childNodes.length-1;a>=0;a-=1)this[t].insertBefore(r.childNodes[a],this[t].childNodes[0])}else if(e instanceof Dom7)for(a=0;a<e.length;a+=1)this[t].insertBefore(e[a],this[t].childNodes[0]);else this[t].insertBefore(e,this[t].childNodes[0]);return this}function prependTo(e){return $(e).prepend(this),this}function insertBefore(e){for(var t=$(e),a=0;a<this.length;a+=1)if(1===t.length)t[0].parentNode.insertBefore(this[a],t[0]);else if(t.length>1)for(var r=0;r<t.length;r+=1)t[r].parentNode.insertBefore(this[a].cloneNode(!0),t[r])}function insertAfter(e){for(var t=$(e),a=0;a<this.length;a+=1)if(1===t.length)t[0].parentNode.insertBefore(this[a],t[0].nextSibling);else if(t.length>1)for(var r=0;r<t.length;r+=1)t[r].parentNode.insertBefore(this[a].cloneNode(!0),t[r].nextSibling)}function next(e){return this.length>0?e?this[0].nextElementSibling&&$(this[0].nextElementSibling).is(e)?new Dom7([this[0].nextElementSibling]):new Dom7([]):this[0].nextElementSibling?new Dom7([this[0].nextElementSibling]):new Dom7([]):new Dom7([])}function nextAll(e){var t=[],a=this[0];if(!a)return new Dom7([]);for(;a.nextElementSibling;){var r=a.nextElementSibling;e?$(r).is(e)&&t.push(r):t.push(r),a=r}return new Dom7(t)}function prev(e){if(this.length>0){var t=this[0];return e?t.previousElementSibling&&$(t.previousElementSibling).is(e)?new Dom7([t.previousElementSibling]):new Dom7([]):t.previousElementSibling?new Dom7([t.previousElementSibling]):new Dom7([])}return new Dom7([])}function prevAll(e){var t=[],a=this[0];if(!a)return new Dom7([]);for(;a.previousElementSibling;){var r=a.previousElementSibling;e?$(r).is(e)&&t.push(r):t.push(r),a=r}return new Dom7(t)}function siblings(e){return this.nextAll(e).add(this.prevAll(e))}function parent(e){for(var t=[],a=0;a<this.length;a+=1)null!==this[a].parentNode&&(e?$(this[a].parentNode).is(e)&&t.push(this[a].parentNode):t.push(this[a].parentNode));return $(unique(t))}function parents(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].parentNode;r;)e?$(r).is(e)&&t.push(r):t.push(r),r=r.parentNode;return $(unique(t))}function closest(e){var t=this;return void 0===e?new Dom7([]):(t.is(e)||(t=t.parents(e).eq(0)),t)}function find(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].querySelectorAll(e),i=0;i<r.length;i+=1)t.push(r[i]);return new Dom7(t)}function children(e){for(var t=[],a=0;a<this.length;a+=1)for(var r=this[a].childNodes,i=0;i<r.length;i+=1)e?1===r[i].nodeType&&$(r[i]).is(e)&&t.push(r[i]):1===r[i].nodeType&&t.push(r[i]);return new Dom7(unique(t))}function remove(){for(var e=0;e<this.length;e+=1)this[e].parentNode&&this[e].parentNode.removeChild(this[e]);return this}function detach(){return this.remove()}function add(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r;for(a=0;a<e.length;a+=1){var i=$(e[a]);for(r=0;r<i.length;r+=1)this[this.length]=i[r],this.length+=1}return this}function empty(){for(var e=0;e<this.length;e+=1){var t=this[e];if(1===t.nodeType){for(var a=0;a<t.childNodes.length;a+=1)t.childNodes[a].parentNode&&t.childNodes[a].parentNode.removeChild(t.childNodes[a]);t.textContent=""}}return this}$.fn=Dom7.prototype,$.Class=Dom7,$.Dom7=Dom7;var Methods=Object.freeze({addClass:addClass,removeClass:removeClass,hasClass:hasClass,toggleClass:toggleClass,attr:attr,removeAttr:removeAttr,prop:prop,data:data,removeData:removeData,dataset:dataset,val:val,transform:transform,transition:transition,on:on,off:off,once:once,trigger:trigger,transitionEnd:transitionEnd,animationEnd:animationEnd,width:width,outerWidth:outerWidth,height:height,outerHeight:outerHeight,offset:offset,hide:hide,show:show,styles:styles,css:css,toArray:toArray,each:each,forEach:forEach,filter:filter,map:map,html:html,text:text,is:is,indexOf:indexOf,index:index,eq:eq,append:append,appendTo:appendTo,prepend:prepend,prependTo:prependTo,insertBefore:insertBefore,insertAfter:insertAfter,next:next,nextAll:nextAll,prev:prev,prevAll:prevAll,siblings:siblings,parent:parent,parents:parents,closest:closest,find:find,children:children,remove:remove,detach:detach,add:add,empty:empty});function scrollTo(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2],s=t[3],o=t[4];return 4===t.length&&"function"==typeof s&&(o=s,r=(e=t)[0],i=e[1],n=e[2],o=e[3],s=e[4]),void 0===s&&(s="swing"),this.each(function(){var e,t,a,l,p,c,d,u,h=this,f=i>0||0===i,v=r>0||0===r;if(void 0===s&&(s="swing"),f&&(e=h.scrollTop,n||(h.scrollTop=i)),v&&(t=h.scrollLeft,n||(h.scrollLeft=r)),n){f&&(a=h.scrollHeight-h.offsetHeight,p=Math.max(Math.min(i,a),0)),v&&(l=h.scrollWidth-h.offsetWidth,c=Math.max(Math.min(r,l),0));var m=null;f&&p===e&&(f=!1),v&&c===t&&(v=!1),requestAnimationFrame(function a(r){void 0===r&&(r=(new Date).getTime()),null===m&&(m=r);var i,l=Math.max(Math.min((r-m)/n,1),0),g="linear"===s?l:.5-Math.cos(l*Math.PI)/2;f&&(d=e+g*(p-e)),v&&(u=t+g*(c-t)),f&&p>e&&d>=p&&(h.scrollTop=p,i=!0),f&&p<e&&d<=p&&(h.scrollTop=p,i=!0),v&&c>t&&u>=c&&(h.scrollLeft=c,i=!0),v&&c<t&&u<=c&&(h.scrollLeft=c,i=!0),i?o&&o():(f&&(h.scrollTop=d),v&&(h.scrollLeft=u),requestAnimationFrame(a))})}})}function scrollTop(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2],s=t[3];3===t.length&&"function"==typeof n&&(r=(e=t)[0],i=e[1],s=e[2],n=e[3]);return void 0===r?this.length>0?this[0].scrollTop:null:this.scrollTo(void 0,r,i,n,s)}function scrollLeft(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2],s=t[3];3===t.length&&"function"==typeof n&&(r=(e=t)[0],i=e[1],s=e[2],n=e[3]);return void 0===r?this.length>0?this[0].scrollLeft:null:this.scrollTo(r,void 0,i,n,s)}var Scroll=Object.freeze({scrollTo:scrollTo,scrollTop:scrollTop,scrollLeft:scrollLeft});function animate(e,t){var a,r=this,i={props:Object.assign({},e),params:Object.assign({duration:300,easing:"swing"},t),elements:r,animating:!1,que:[],easingProgress:function(e,t){return"swing"===e?.5-Math.cos(t*Math.PI)/2:"function"==typeof e?e(t):t},stop:function(){i.frameId&&cancelAnimationFrame(i.frameId),i.animating=!1,i.elements.each(function(e,t){delete t.dom7AnimateInstance}),i.que=[]},done:function(e){if(i.animating=!1,i.elements.each(function(e,t){delete t.dom7AnimateInstance}),e&&e(r),i.que.length>0){var t=i.que.shift();i.animate(t[0],t[1])}},animate:function(e,t){if(i.animating)return i.que.push([e,t]),i;var a=[];i.elements.each(function(t,r){var n,s,o,l,p;r.dom7AnimateInstance||(i.elements[t].dom7AnimateInstance=i),a[t]={container:r},Object.keys(e).forEach(function(i){n=win.getComputedStyle(r,null).getPropertyValue(i).replace(",","."),s=parseFloat(n),o=n.replace(s,""),l=parseFloat(e[i]),p=e[i]+o,a[t][i]={initialFullValue:n,initialValue:s,unit:o,finalValue:l,finalFullValue:p,currentValue:s}})});var n,s,o=null,l=0,p=0,c=!1;return i.animating=!0,i.frameId=requestAnimationFrame(function d(){var u,h;n=(new Date).getTime(),c||(c=!0,t.begin&&t.begin(r)),null===o&&(o=n),t.progress&&t.progress(r,Math.max(Math.min((n-o)/t.duration,1),0),o+t.duration-n<0?0:o+t.duration-n,o),a.forEach(function(r){var c=r;s||c.done||Object.keys(e).forEach(function(r){if(!s&&!c.done){u=Math.max(Math.min((n-o)/t.duration,1),0),h=i.easingProgress(t.easing,u);var d=c[r],f=d.initialValue,v=d.finalValue,m=d.unit;c[r].currentValue=f+h*(v-f);var g=c[r].currentValue;(v>f&&g>=v||v<f&&g<=v)&&(c.container.style[r]=v+m,(p+=1)===Object.keys(e).length&&(c.done=!0,l+=1),l===a.length&&(s=!0)),s?i.done(t.complete):c.container.style[r]=g+m}})}),s||(i.frameId=requestAnimationFrame(d))}),i}};if(0===i.elements.length)return r;for(var n=0;n<i.elements.length;n+=1)i.elements[n].dom7AnimateInstance?a=i.elements[n].dom7AnimateInstance:i.elements[n].dom7AnimateInstance=i;return a||(a=i),"stop"===e?a.stop():a.animate(i.props,i.params),r}function stop(){for(var e=0;e<this.length;e+=1)this[e].dom7AnimateInstance&&this[e].dom7AnimateInstance.stop()}var Animate=Object.freeze({animate:animate,stop:stop}),noTrigger="resize scroll".split(" ");function eventShortcut(e){for(var t,a=[],r=arguments.length-1;r-- >0;)a[r]=arguments[r+1];if(void 0===a[0]){for(var i=0;i<this.length;i+=1)noTrigger.indexOf(e)<0&&(e in this[i]?this[i][e]():$(this[i]).trigger(e));return this}return(t=this).on.apply(t,[e].concat(a))}function click(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["click"].concat(e))}function blur(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["blur"].concat(e))}function focus(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focus"].concat(e))}function focusin(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focusin"].concat(e))}function focusout(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["focusout"].concat(e))}function keyup(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keyup"].concat(e))}function keydown(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keydown"].concat(e))}function keypress(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["keypress"].concat(e))}function submit(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["submit"].concat(e))}function change(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["change"].concat(e))}function mousedown(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mousedown"].concat(e))}function mousemove(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mousemove"].concat(e))}function mouseup(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseup"].concat(e))}function mouseenter(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseenter"].concat(e))}function mouseleave(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseleave"].concat(e))}function mouseout(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseout"].concat(e))}function mouseover(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["mouseover"].concat(e))}function touchstart(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchstart"].concat(e))}function touchend(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchend"].concat(e))}function touchmove(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["touchmove"].concat(e))}function resize(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["resize"].concat(e))}function scroll(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return eventShortcut.bind(this).apply(void 0,["scroll"].concat(e))}var eventShortcuts=Object.freeze({click:click,blur:blur,focus:focus,focusin:focusin,focusout:focusout,keyup:keyup,keydown:keydown,keypress:keypress,submit:submit,change:change,mousedown:mousedown,mousemove:mousemove,mouseup:mouseup,mouseenter:mouseenter,mouseleave:mouseleave,mouseout:mouseout,mouseover:mouseover,touchstart:touchstart,touchend:touchend,touchmove:touchmove,resize:resize,scroll:scroll});[Methods,Scroll,Animate,eventShortcuts].forEach(function(e){Object.keys(e).forEach(function(t){$.fn[t]=e[t]})});var NEWTON_ITERATIONS=4,NEWTON_MIN_SLOPE=.001,SUBDIVISION_PRECISION=1e-7,SUBDIVISION_MAX_ITERATIONS=10,kSplineTableSize=11,kSampleStepSize=1/(kSplineTableSize-1),float32ArraySupported="function"==typeof Float32Array;function A(e,t){return 1-3*t+3*e}function B(e,t){return 3*t-6*e}function C(e){return 3*e}function calcBezier(e,t,a){return((A(t,a)*e+B(t,a))*e+C(t))*e}function getSlope(e,t,a){return 3*A(t,a)*e*e+2*B(t,a)*e+C(t)}function binarySubdivide(e,t,a,r,i){var n,s,o=0;do{(n=calcBezier(s=t+(a-t)/2,r,i)-e)>0?a=s:t=s}while(Math.abs(n)>SUBDIVISION_PRECISION&&++o<SUBDIVISION_MAX_ITERATIONS);return s}function newtonRaphsonIterate(e,t,a,r){for(var i=0;i<NEWTON_ITERATIONS;++i){var n=getSlope(t,a,r);if(0===n)return t;t-=(calcBezier(t,a,r)-e)/n}return t}function bezier(e,t,a,r){if(!(0<=e&&e<=1&&0<=a&&a<=1))throw new Error("bezier x values must be in [0, 1] range");var i=float32ArraySupported?new Float32Array(kSplineTableSize):new Array(kSplineTableSize);if(e!==t||a!==r)for(var n=0;n<kSplineTableSize;++n)i[n]=calcBezier(n*kSampleStepSize,e,a);return function(n){return e===t&&a===r?n:0===n?0:1===n?1:calcBezier(function(t){for(var r=0,n=1,s=kSplineTableSize-1;n!==s&&i[n]<=t;++n)r+=kSampleStepSize;var o=r+(t-i[--n])/(i[n+1]-i[n])*kSampleStepSize,l=getSlope(o,e,a);return l>=NEWTON_MIN_SLOPE?newtonRaphsonIterate(t,o,e,a):0===l?o:binarySubdivide(t,r,r+kSampleStepSize,e,a)}(n),t,r)}}for(var defaultDiacriticsRemovalap=[{base:"A",letters:"AⒶＡÀÁÂẦẤẪẨÃĀĂẰẮẴẲȦǠÄǞẢÅǺǍȀȂẠẬẶḀĄȺⱯ"},{base:"AA",letters:"Ꜳ"},{base:"AE",letters:"ÆǼǢ"},{base:"AO",letters:"Ꜵ"},{base:"AU",letters:"Ꜷ"},{base:"AV",letters:"ꜸꜺ"},{base:"AY",letters:"Ꜽ"},{base:"B",letters:"BⒷＢḂḄḆɃƂƁ"},{base:"C",letters:"CⒸＣĆĈĊČÇḈƇȻꜾ"},{base:"D",letters:"DⒹＤḊĎḌḐḒḎĐƋƊƉꝹ"},{base:"DZ",letters:"ǱǄ"},{base:"Dz",letters:"ǲǅ"},{base:"E",letters:"EⒺＥÈÉÊỀẾỄỂẼĒḔḖĔĖËẺĚȄȆẸỆȨḜĘḘḚƐƎ"},{base:"F",letters:"FⒻＦḞƑꝻ"},{base:"G",letters:"GⒼＧǴĜḠĞĠǦĢǤƓꞠꝽꝾ"},{base:"H",letters:"HⒽＨĤḢḦȞḤḨḪĦⱧⱵꞍ"},{base:"I",letters:"IⒾＩÌÍÎĨĪĬİÏḮỈǏȈȊỊĮḬƗ"},{base:"J",letters:"JⒿＪĴɈ"},{base:"K",letters:"KⓀＫḰǨḲĶḴƘⱩꝀꝂꝄꞢ"},{base:"L",letters:"LⓁＬĿĹĽḶḸĻḼḺŁȽⱢⱠꝈꝆꞀ"},{base:"LJ",letters:"Ǉ"},{base:"Lj",letters:"ǈ"},{base:"M",letters:"MⓂＭḾṀṂⱮƜ"},{base:"N",letters:"NⓃＮǸŃÑṄŇṆŅṊṈȠƝꞐꞤ"},{base:"NJ",letters:"Ǌ"},{base:"Nj",letters:"ǋ"},{base:"O",letters:"OⓄＯÒÓÔỒỐỖỔÕṌȬṎŌṐṒŎȮȰÖȪỎŐǑȌȎƠỜỚỠỞỢỌỘǪǬØǾƆƟꝊꝌ"},{base:"OI",letters:"Ƣ"},{base:"OO",letters:"Ꝏ"},{base:"OU",letters:"Ȣ"},{base:"OE",letters:"Œ"},{base:"oe",letters:"œ"},{base:"P",letters:"PⓅＰṔṖƤⱣꝐꝒꝔ"},{base:"Q",letters:"QⓆＱꝖꝘɊ"},{base:"R",letters:"RⓇＲŔṘŘȐȒṚṜŖṞɌⱤꝚꞦꞂ"},{base:"S",letters:"SⓈＳẞŚṤŜṠŠṦṢṨȘŞⱾꞨꞄ"},{base:"T",letters:"TⓉＴṪŤṬȚŢṰṮŦƬƮȾꞆ"},{base:"TZ",letters:"Ꜩ"},{base:"U",letters:"UⓊＵÙÚÛŨṸŪṺŬÜǛǗǕǙỦŮŰǓȔȖƯỪỨỮỬỰỤṲŲṶṴɄ"},{base:"V",letters:"VⓋＶṼṾƲꝞɅ"},{base:"VY",letters:"Ꝡ"},{base:"W",letters:"WⓌＷẀẂŴẆẄẈⱲ"},{base:"X",letters:"XⓍＸẊẌ"},{base:"Y",letters:"YⓎＹỲÝŶỸȲẎŸỶỴƳɎỾ"},{base:"Z",letters:"ZⓏＺŹẐŻŽẒẔƵȤⱿⱫꝢ"},{base:"a",letters:"aⓐａẚàáâầấẫẩãāăằắẵẳȧǡäǟảåǻǎȁȃạậặḁąⱥɐ"},{base:"aa",letters:"ꜳ"},{base:"ae",letters:"æǽǣ"},{base:"ao",letters:"ꜵ"},{base:"au",letters:"ꜷ"},{base:"av",letters:"ꜹꜻ"},{base:"ay",letters:"ꜽ"},{base:"b",letters:"bⓑｂḃḅḇƀƃɓ"},{base:"c",letters:"cⓒｃćĉċčçḉƈȼꜿↄ"},{base:"d",letters:"dⓓｄḋďḍḑḓḏđƌɖɗꝺ"},{base:"dz",letters:"ǳǆ"},{base:"e",letters:"eⓔｅèéêềếễểẽēḕḗĕėëẻěȅȇẹệȩḝęḙḛɇɛǝ"},{base:"f",letters:"fⓕｆḟƒꝼ"},{base:"g",letters:"gⓖｇǵĝḡğġǧģǥɠꞡᵹꝿ"},{base:"h",letters:"hⓗｈĥḣḧȟḥḩḫẖħⱨⱶɥ"},{base:"hv",letters:"ƕ"},{base:"i",letters:"iⓘｉìíîĩīĭïḯỉǐȉȋịįḭɨı"},{base:"j",letters:"jⓙｊĵǰɉ"},{base:"k",letters:"kⓚｋḱǩḳķḵƙⱪꝁꝃꝅꞣ"},{base:"l",letters:"lⓛｌŀĺľḷḹļḽḻſłƚɫⱡꝉꞁꝇ"},{base:"lj",letters:"ǉ"},{base:"m",letters:"mⓜｍḿṁṃɱɯ"},{base:"n",letters:"nⓝｎǹńñṅňṇņṋṉƞɲŉꞑꞥ"},{base:"nj",letters:"ǌ"},{base:"o",letters:"oⓞｏòóôồốỗổõṍȭṏōṑṓŏȯȱöȫỏőǒȍȏơờớỡởợọộǫǭøǿɔꝋꝍɵ"},{base:"oi",letters:"ƣ"},{base:"ou",letters:"ȣ"},{base:"oo",letters:"ꝏ"},{base:"p",letters:"pⓟｐṕṗƥᵽꝑꝓꝕ"},{base:"q",letters:"qⓠｑɋꝗꝙ"},{base:"r",letters:"rⓡｒŕṙřȑȓṛṝŗṟɍɽꝛꞧꞃ"},{base:"s",letters:"sⓢｓßśṥŝṡšṧṣṩșşȿꞩꞅẛ"},{base:"t",letters:"tⓣｔṫẗťṭțţṱṯŧƭʈⱦꞇ"},{base:"tz",letters:"ꜩ"},{base:"u",letters:"uⓤｕùúûũṹūṻŭüǜǘǖǚủůűǔȕȗưừứữửựụṳųṷṵʉ"},{base:"v",letters:"vⓥｖṽṿʋꝟʌ"},{base:"vy",letters:"ꝡ"},{base:"w",letters:"wⓦｗẁẃŵẇẅẘẉⱳ"},{base:"x",letters:"xⓧｘẋẍ"},{base:"y",letters:"yⓨｙỳýŷỹȳẏÿỷẙỵƴɏỿ"},{base:"z",letters:"zⓩｚźẑżžẓẕƶȥɀⱬꝣ"}],diacriticsMap={},i=0;i<defaultDiacriticsRemovalap.length;i+=1)for(var letters=defaultDiacriticsRemovalap[i].letters,j=0;j<letters.length;j+=1)diacriticsMap[letters[j]]=defaultDiacriticsRemovalap[i].base;var uniqueNumber=1,Utils={uniqueNumber:function(){return uniqueNumber+=1},id:function(e,t){void 0===e&&(e="xxxxxxxxxx"),void 0===t&&(t="0123456789abcdef");var a=t.length;return e.replace(/x/g,function(){return t[Math.floor(Math.random()*a)]})},mdPreloaderContent:'\n    <span class="preloader-inner">\n      <span class="preloader-inner-gap"></span>\n      <span class="preloader-inner-left">\n          <span class="preloader-inner-half-circle"></span>\n      </span>\n      <span class="preloader-inner-right">\n          <span class="preloader-inner-half-circle"></span>\n      </span>\n    </span>\n  '.trim(),iosPreloaderContent:('\n    <span class="preloader-inner">\n      '+[0,1,2,3,4,5,6,7,8,9,10,11].map(function(){return'<span class="preloader-inner-line"></span>'}).join("")+"\n    </span>\n  ").trim(),auroraPreloaderContent:'\n    <span class="preloader-inner">\n      <span class="preloader-inner-circle"></span>\n    </span>\n  ',eventNameToColonCase:function(e){var t;return e.split("").map(function(e,a){return e.match(/[A-Z]/)&&0!==a&&!t?(t=!0,":"+e.toLowerCase()):e.toLowerCase()}).join("")},deleteProps:function(e){var t=e;Object.keys(t).forEach(function(e){try{t[e]=null}catch(e){}try{delete t[e]}catch(e){}})},bezier:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return bezier.apply(void 0,e)},nextTick:function(e,t){return void 0===t&&(t=0),setTimeout(e,t)},nextFrame:function(e){return Utils.requestAnimationFrame(function(){Utils.requestAnimationFrame(e)})},now:function(){return Date.now()},requestAnimationFrame:function(e){return win.requestAnimationFrame(e)},cancelAnimationFrame:function(e){return win.cancelAnimationFrame(e)},removeDiacritics:function(e){return e.replace(/[^\u0000-\u007E]/g,function(e){return diacriticsMap[e]||e})},parseUrlQuery:function(e){var t,a,r,i,n={},s=e||win.location.href;if("string"==typeof s&&s.length)for(i=(a=(s=s.indexOf("?")>-1?s.replace(/\S*\?/,""):"").split("&").filter(function(e){return""!==e})).length,t=0;t<i;t+=1)r=a[t].replace(/#\S+/g,"").split("="),n[decodeURIComponent(r[0])]=void 0===r[1]?void 0:decodeURIComponent(r.slice(1).join("="))||"";return n},getTranslate:function(e,t){var a,r,i;void 0===t&&(t="x");var n=win.getComputedStyle(e,null);return win.WebKitCSSMatrix?((r=n.transform||n.webkitTransform).split(",").length>6&&(r=r.split(", ").map(function(e){return e.replace(",",".")}).join(", ")),i=new win.WebKitCSSMatrix("none"===r?"":r)):a=(i=n.MozTransform||n.OTransform||n.MsTransform||n.msTransform||n.transform||n.getPropertyValue("transform").replace("translate(","matrix(1, 0, 0, 1,")).toString().split(","),"x"===t&&(r=win.WebKitCSSMatrix?i.m41:16===a.length?parseFloat(a[12]):parseFloat(a[4])),"y"===t&&(r=win.WebKitCSSMatrix?i.m42:16===a.length?parseFloat(a[13]):parseFloat(a[5])),r||0},serializeObject:function(e,t){if(void 0===t&&(t=[]),"string"==typeof e)return e;var a,r=[];function i(e){if(t.length>0){for(var a="",r=0;r<t.length;r+=1)a+=0===r?t[r]:"["+encodeURIComponent(t[r])+"]";return a+"["+encodeURIComponent(e)+"]"}return encodeURIComponent(e)}function n(e){return encodeURIComponent(e)}return Object.keys(e).forEach(function(s){var o;if(Array.isArray(e[s])){o=[];for(var l=0;l<e[s].length;l+=1)Array.isArray(e[s][l])||"object"!=typeof e[s][l]?o.push(i(s)+"[]="+n(e[s][l])):((a=t.slice()).push(s),a.push(String(l)),o.push(Utils.serializeObject(e[s][l],a)));o.length>0&&r.push(o.join("&"))}else null===e[s]||""===e[s]?r.push(i(s)+"="):"object"==typeof e[s]?((a=t.slice()).push(s),""!==(o=Utils.serializeObject(e[s],a))&&r.push(o)):void 0!==e[s]&&""!==e[s]?r.push(i(s)+"="+n(e[s])):""===e[s]&&r.push(i(s))}),r.join("&")},isObject:function(e){return"object"==typeof e&&null!==e&&e.constructor&&e.constructor===Object},merge:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a=e[0];e.splice(0,1);for(var r=e,i=0;i<r.length;i+=1){var n=e[i];if(null!=n)for(var s=Object.keys(Object(n)),o=0,l=s.length;o<l;o+=1){var p=s[o],c=Object.getOwnPropertyDescriptor(n,p);void 0!==c&&c.enumerable&&(a[p]=n[p])}}return a},extend:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,i=!0;"boolean"==typeof e[0]?(i=e[0],a=e[1],e.splice(0,2),r=e):(a=e[0],e.splice(0,1),r=e);for(var n=0;n<r.length;n+=1){var s=e[n];if(null!=s)for(var o=Object.keys(Object(s)),l=0,p=o.length;l<p;l+=1){var c=o[l],d=Object.getOwnPropertyDescriptor(s,c);void 0!==d&&d.enumerable&&(i?Utils.isObject(a[c])&&Utils.isObject(s[c])?Utils.extend(a[c],s[c]):!Utils.isObject(a[c])&&Utils.isObject(s[c])?(a[c]={},Utils.extend(a[c],s[c])):a[c]=s[c]:a[c]=s[c])}}return a},colorHexToRgb:function(e){var t=e.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i,function(e,t,a,r){return t+t+a+a+r+r}),a=/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(t);return a?a.slice(1).map(function(e){return parseInt(e,16)}):null},colorRgbToHex:function(e,t,a){return"#"+[e,t,a].map(function(e){var t=e.toString(16);return 1===t.length?"0"+t:t}).join("")},colorRgbToHsl:function(e,t,a){e/=255,t/=255,a/=255;var r,i=Math.max(e,t,a),n=Math.min(e,t,a),s=i-n;0===s?r=0:i===e?r=(t-a)/s%6:i===t?r=(a-e)/s+2:i===a&&(r=(e-t)/s+4);var o=(n+i)/2;return r<0&&(r=6+r),[60*r,0===s?0:s/(1-Math.abs(2*o-1)),o]},colorHslToRgb:function(e,t,a){var r,i=(1-Math.abs(2*a-1))*t,n=e/60,s=i*(1-Math.abs(n%2-1));Number.isNaN(e)||void 0===e?r=[0,0,0]:n<=1?r=[i,s,0]:n<=2?r=[s,i,0]:n<=3?r=[0,i,s]:n<=4?r=[0,s,i]:n<=5?r=[s,0,i]:n<=6&&(r=[i,0,s]);var o=a-i/2;return r.map(function(e){return Math.max(0,Math.min(255,Math.round(255*(e+o))))})},colorHsbToHsl:function(e,t,a){var r={h:e,s:0,l:0},i=t,n=a;return r.l=(2-i)*n/2,r.s=r.l&&r.l<1?i*n/(r.l<.5?2*r.l:2-2*r.l):r.s,[r.h,r.s,r.l]},colorHslToHsb:function(e,t,a){var r={h:e,s:0,b:0},i=a,n=t*(i<.5?i:1-i);return r.b=i+n,r.s=i>0?2*n/r.b:r.s,[r.h,r.s,r.b]},colorThemeCSSProperties:function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];if(1===a.length?(e=a[0],t=Utils.colorHexToRgb(e)):3===a.length&&(t=a,e=Utils.colorRgbToHex.apply(Utils,t)),!t)return{};var i=Utils.colorRgbToHsl.apply(Utils,t),n=[i[0],i[1],Math.max(0,i[2]-.08)],s=[i[0],i[1],Math.max(0,i[2]+.08)],o=Utils.colorRgbToHex.apply(Utils,Utils.colorHslToRgb.apply(Utils,n)),l=Utils.colorRgbToHex.apply(Utils,Utils.colorHslToRgb.apply(Utils,s));return{"--f7-theme-color":e,"--f7-theme-color-rgb":t.join(", "),"--f7-theme-color-shade":o,"--f7-theme-color-tint":l}}},Support=(testDiv=doc.createElement("div"),{touch:!!(win.navigator.maxTouchPoints>0||"ontouchstart"in win||win.DocumentTouch&&doc instanceof win.DocumentTouch),pointerEvents:!!(win.navigator.pointerEnabled||win.PointerEvent||"maxTouchPoints"in win.navigator&&win.navigator.maxTouchPoints>0),prefixedPointerEvents:!!win.navigator.msPointerEnabled,transition:(style=testDiv.style,"transition"in style||"webkitTransition"in style||"MozTransition"in style),transforms3d:win.Modernizr&&!0===win.Modernizr.csstransforms3d||function(){var e=testDiv.style;return"webkitPerspective"in e||"MozPerspective"in e||"OPerspective"in e||"MsPerspective"in e||"perspective"in e}(),flexbox:function(){for(var e=doc.createElement("div").style,t="alignItems webkitAlignItems webkitBoxAlign msFlexAlign mozBoxAlign webkitFlexDirection msFlexDirection mozBoxDirection mozBoxOrient webkitBoxDirection webkitBoxOrient".split(" "),a=0;a<t.length;a+=1)if(t[a]in e)return!0;return!1}(),observer:"MutationObserver"in win||"WebkitMutationObserver"in win,passiveListener:function(){var e=!1;try{var t=Object.defineProperty({},"passive",{get:function(){e=!0}});win.addEventListener("testPassiveListener",null,t)}catch(e){}return e}(),gestures:"ongesturestart"in win,intersectionObserver:"IntersectionObserver"in win}),style,testDiv,Device=function(){var e=win.navigator.platform,t=win.navigator.userAgent,a={ios:!1,android:!1,androidChrome:!1,desktop:!1,windowsPhone:!1,iphone:!1,iphoneX:!1,ipod:!1,ipad:!1,edge:!1,ie:!1,firefox:!1,macos:!1,windows:!1,cordova:!(!win.cordova&&!win.phonegap),phonegap:!(!win.cordova&&!win.phonegap),electron:!1},r=win.screen.width,i=win.screen.height,n=t.match(/(Windows Phone);?[\s\/]+([\d.]+)?/),s=t.match(/(Android);?[\s\/]+([\d.]+)?/),o=t.match(/(iPad).*OS\s([\d_]+)/),l=t.match(/(iPod)(.*OS\s([\d_]+))?/),p=!o&&t.match(/(iPhone\sOS|iOS)\s([\d_]+)/),c=p&&(375===r&&812===i||414===r&&896===i),d=t.indexOf("MSIE ")>=0||t.indexOf("Trident/")>=0,u=t.indexOf("Edge/")>=0,h=t.indexOf("Gecko/")>=0&&t.indexOf("Firefox/")>=0,f="Win32"===e,v=t.toLowerCase().indexOf("electron")>=0,m="MacIntel"===e;!o&&m&&Support.touch&&(1024===r&&1366===i||834===r&&1194===i||834===r&&1112===i||768===r&&1024===i)&&(o=t.match(/(Version)\/([\d.]+)/),m=!1),a.ie=d,a.edge=u,a.firefox=h,n&&(a.os="windowsPhone",a.osVersion=n[2],a.windowsPhone=!0),s&&!f&&(a.os="android",a.osVersion=s[2],a.android=!0,a.androidChrome=t.toLowerCase().indexOf("chrome")>=0),(o||p||l)&&(a.os="ios",a.ios=!0),p&&!l&&(a.osVersion=p[2].replace(/_/g,"."),a.iphone=!0,a.iphoneX=c),o&&(a.osVersion=o[2].replace(/_/g,"."),a.ipad=!0),l&&(a.osVersion=l[3]?l[3].replace(/_/g,"."):null,a.ipod=!0),a.ios&&a.osVersion&&t.indexOf("Version/")>=0&&"10"===a.osVersion.split(".")[0]&&(a.osVersion=t.toLowerCase().split("version/")[1].split(" ")[0]),a.webView=!(!(p||o||l)||!t.match(/.*AppleWebKit(?!.*Safari)/i)&&!win.navigator.standalone)||win.matchMedia&&win.matchMedia("(display-mode: standalone)").matches,a.webview=a.webView,a.standalone=a.webView,a.desktop=!(a.ios||a.android||a.windowsPhone)||v,a.desktop&&(a.electron=v,a.macos=m,a.windows=f,a.macos&&(a.os="macos"),a.windows&&(a.os="windows"));var g=doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');a.needsStatusbarOverlay=function(){return!a.desktop&&(!!(a.standalone&&a.ios&&g&&"black-translucent"===g.content)||!(!(a.webView||a.android&&a.cordova)||win.innerWidth*win.innerHeight!=win.screen.width*win.screen.height)&&(!a.iphoneX||90!==win.orientation&&-90!==win.orientation))},a.statusbar=a.needsStatusbarOverlay(),a.pixelRatio=win.devicePixelRatio||1;return a.prefersColorScheme=function(){var e;return win.matchMedia&&win.matchMedia("(prefers-color-scheme: light)").matches&&(e="light"),win.matchMedia&&win.matchMedia("(prefers-color-scheme: dark)").matches&&(e="dark"),e},a}(),EventsClass=function(e){void 0===e&&(e=[]);this.eventsParents=e,this.eventsListeners={}};EventsClass.prototype.on=function(e,t,a){var r=this;if("function"!=typeof t)return r;var i=a?"unshift":"push";return e.split(" ").forEach(function(e){r.eventsListeners[e]||(r.eventsListeners[e]=[]),r.eventsListeners[e][i](t)}),r},EventsClass.prototype.once=function(e,t,a){var r=this;if("function"!=typeof t)return r;function i(){for(var a=[],n=arguments.length;n--;)a[n]=arguments[n];t.apply(r,a),r.off(e,i),i.f7proxy&&delete i.f7proxy}return i.f7proxy=t,r.on(e,i,a)},EventsClass.prototype.off=function(e,t){var a=this;return a.eventsListeners?(e.split(" ").forEach(function(e){void 0===t?a.eventsListeners[e]=[]:a.eventsListeners[e]&&a.eventsListeners[e].forEach(function(r,i){(r===t||r.f7proxy&&r.f7proxy===t)&&a.eventsListeners[e].splice(i,1)})}),a):a},EventsClass.prototype.emit=function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,i,n,s=this;if(!s.eventsListeners)return s;"string"==typeof e[0]||Array.isArray(e[0])?(a=e[0],r=e.slice(1,e.length),i=s,n=s.eventsParents):(a=e[0].events,r=e[0].data,i=e[0].context||s,n=e[0].local?[]:e[0].parents||s.eventsParents);var o=Array.isArray(a)?a:a.split(" "),l=o.map(function(e){return e.replace("local::","")}),p=o.filter(function(e){return e.indexOf("local::")<0});return l.forEach(function(e){if(s.eventsListeners&&s.eventsListeners[e]){var t=[];s.eventsListeners[e].forEach(function(e){t.push(e)}),t.forEach(function(e){e.apply(i,r)})}}),n&&n.length>0&&n.forEach(function(e){e.emit.apply(e,[p].concat(r))}),s};var Framework7Class=function(e){function t(t,a){void 0===t&&(t={}),void 0===a&&(a=[]),e.call(this,a);var r=this;r.params=t,r.params&&r.params.on&&Object.keys(r.params.on).forEach(function(e){r.on(e,r.params.on[e])})}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={components:{configurable:!0}};return t.prototype.useModuleParams=function(e,t){if(e.params){var a={};Object.keys(e.params).forEach(function(e){void 0!==t[e]&&(a[e]=Utils.extend({},t[e]))}),Utils.extend(t,e.params),Object.keys(a).forEach(function(e){Utils.extend(t[e],a[e])})}},t.prototype.useModulesParams=function(e){var t=this;t.modules&&Object.keys(t.modules).forEach(function(a){var r=t.modules[a];r.params&&Utils.extend(e,r.params)})},t.prototype.useModule=function(e,t){void 0===e&&(e=""),void 0===t&&(t={});var a=this;if(a.modules){var r="string"==typeof e?a.modules[e]:e;r&&(r.instance&&Object.keys(r.instance).forEach(function(e){var t=r.instance[e];a[e]="function"==typeof t?t.bind(a):t}),r.on&&a.on&&Object.keys(r.on).forEach(function(e){a.on(e,r.on[e])}),r.vnode&&(a.vnodeHooks||(a.vnodeHooks={}),Object.keys(r.vnode).forEach(function(e){Object.keys(r.vnode[e]).forEach(function(t){var i=r.vnode[e][t];a.vnodeHooks[t]||(a.vnodeHooks[t]={}),a.vnodeHooks[t][e]||(a.vnodeHooks[t][e]=[]),a.vnodeHooks[t][e].push(i.bind(a))})})),r.create&&r.create.bind(a)(t))}},t.prototype.useModules=function(e){void 0===e&&(e={});var t=this;t.modules&&Object.keys(t.modules).forEach(function(a){var r=e[a]||{};t.useModule(a,r)})},a.components.set=function(e){this.use&&this.use(e)},t.installModule=function(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=this;r.prototype.modules||(r.prototype.modules={});var i=e.name||Object.keys(r.prototype.modules).length+"_"+Utils.now();return r.prototype.modules[i]=e,e.proto&&Object.keys(e.proto).forEach(function(t){r.prototype[t]=e.proto[t]}),e.static&&Object.keys(e.static).forEach(function(t){r[t]=e.static[t]}),e.install&&e.install.apply(r,t),r},t.use=function(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=this;return Array.isArray(e)?(e.forEach(function(e){return r.installModule(e)}),r):r.installModule.apply(r,[e].concat(t))},Object.defineProperties(t,a),t}(EventsClass);function ConstructorMethods(e){void 0===e&&(e={});var t=e.defaultSelector,a=e.constructor,r=e.domProp,i=e.app,n=e.addMethods,s={create:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return i?new(Function.prototype.bind.apply(a,[null].concat([i],e))):new(Function.prototype.bind.apply(a,[null].concat(e)))},get:function(e){if(void 0===e&&(e=t),e instanceof a)return e;var i=$(e);return 0!==i.length?i[0][r]:void 0},destroy:function(e){var t=s.get(e);if(t&&t.destroy)return t.destroy()}};return n&&Array.isArray(n)&&n.forEach(function(e){s[e]=function(a){void 0===a&&(a=t);for(var r=[],i=arguments.length-1;i-- >0;)r[i]=arguments[i+1];var n=s.get(a);if(n&&n[e])return n[e].apply(n,r)}}),s}function ModalMethods(e){void 0===e&&(e={});var t=e.defaultSelector,a=e.constructor,r=e.app;return Utils.extend(ConstructorMethods({defaultSelector:t,constructor:a,app:r,domProp:"f7Modal"}),{open:function(e,t){var i=$(e),n=i[0].f7Modal;return n||(n=new a(r,{el:i})),n.open(t)},close:function(e,i){void 0===e&&(e=t);var n=$(e);if(0!==n.length){var s=n[0].f7Modal;return s||(s=new a(r,{el:n})),s.close(i)}}})}var fetchedModules=[];function loadModule(e){var t=this;return new Promise(function(a,r){var i,n,s,o=t.instance;if(e){if("string"==typeof e){var l=e.match(/([a-z0-9-]*)/i);if(e.indexOf(".")<0&&l&&l[0].length===e.length){if(!o||o&&!o.params.lazyModulesPath)return void r(new Error('Framework7: "lazyModulesPath" app parameter must be specified to fetch module by name'));i=o.params.lazyModulesPath+"/"+e+".js"}else i=e}else"function"==typeof e?s=e:n=e;if(s){var p=s(t,!1);if(!p)return void r(new Error("Framework7: Can't find Framework7 component in specified component function"));if(t.prototype.modules&&t.prototype.modules[p.name])return void a();h(p),a()}if(n){var c=n;if(!c)return void r(new Error("Framework7: Can't find Framework7 component in specified component"));if(t.prototype.modules&&t.prototype.modules[c.name])return void a();h(c),a()}if(i){if(fetchedModules.indexOf(i)>=0)return void a();fetchedModules.push(i);var d=new Promise(function(e,a){t.request.get(i,function(r){var n="f7_component_loader_callback_"+Utils.id(),s=document.createElement("script");s.innerHTML="window."+n+" = function (Framework7, Framework7AutoInstallComponent) {return "+r.trim()+"}",$("head").append(s);var o=window[n];delete window[n],$(s).remove();var l=o(t,!1);l?t.prototype.modules&&t.prototype.modules[l.name]?e():(h(l),e()):a(new Error("Framework7: Can't find Framework7 component in "+i+" file"))},function(e,t){a(e,t)})}),u=new Promise(function(e){t.request.get(i.replace(".js",o.rtl?".rtl.css":".css"),function(t){var a=document.createElement("style");a.innerHTML=t,$("head").append(a),e()},function(){e()})});Promise.all([d,u]).then(function(){a()}).catch(function(e){r(e)})}}else r(new Error("Framework7: Lazy module must be specified"));function h(e){t.use(e),o&&(o.useModuleParams(e,o.params),o.useModule(e))}})}var Framework7=function(e){function t(a){if(e.call(this,a),t.instance)throw new Error("Framework7 is already initialized and can't be initialized more than once");var r=Utils.extend({},a),i=this;t.instance=i;var n={version:"1.0.0",id:"io.framework7.testapp",root:"body",theme:"auto",language:win.navigator.language,routes:[],name:"Framework7",lazyModulesPath:null,initOnDeviceReady:!0,init:!0,autoDarkTheme:!1};i.useModulesParams(n),i.params=Utils.extend(n,a);var s=$(i.params.root);Utils.extend(i,{id:i.params.id,name:i.params.name,version:i.params.version,routes:i.params.routes,language:i.params.language,root:s,rtl:"rtl"===s.css("direction"),theme:"auto"===i.params.theme?Device.ios?"ios":Device.desktop&&Device.electron?"aurora":"md":i.params.theme,passedParams:r}),i.root&&i.root[0]&&(i.root[0].f7=i),i.useModules(),i.initData();var o="(prefers-color-scheme: dark)",l="(prefers-color-scheme: light)";return i.mq={},win.matchMedia&&(i.mq.dark=win.matchMedia(o),i.mq.light=win.matchMedia(l)),i.colorSchemeListener=function(e){var t=e.matches,a=e.media;if(t){var r=doc.querySelector("html");a===o?r.classList.add("theme-dark"):a===l&&r.classList.remove("theme-dark")}},i.params.init&&(Device.cordova&&i.params.initOnDeviceReady?$(doc).on("deviceready",function(){i.init()}):i.init()),i}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={$:{configurable:!0},t7:{configurable:!0}},r={Dom7:{configurable:!0},$:{configurable:!0},Template7:{configurable:!0},Class:{configurable:!0},Events:{configurable:!0}};return t.prototype.initData=function(){var e=this;e.data={},e.params.data&&"function"==typeof e.params.data?Utils.extend(e.data,e.params.data.bind(e)()):e.params.data&&Utils.extend(e.data,e.params.data),e.methods={},e.params.methods&&Object.keys(e.params.methods).forEach(function(t){"function"==typeof e.params.methods[t]?e.methods[t]=e.params.methods[t].bind(e):e.methods[t]=e.params.methods[t]})},t.prototype.enableAutoDarkTheme=function(){if(win.matchMedia){var e=this,t=doc.querySelector("html");e.mq.dark&&e.mq.light&&(e.mq.dark.addListener(e.colorSchemeListener),e.mq.light.addListener(e.colorSchemeListener)),e.mq.dark&&e.mq.dark.matches?t.classList.add("theme-dark"):e.mq.light&&e.mq.light.matches&&t.classList.remove("theme-dark")}},t.prototype.disableAutoDarkTheme=function(){if(win.matchMedia){this.mq.dark&&this.mq.dark.removeListener(this.colorSchemeListener),this.mq.light&&this.mq.light.removeListener(this.colorSchemeListener)}},t.prototype.init=function(){var e=this;return e.initialized?e:(e.root.addClass("framework7-initializing"),e.rtl&&$("html").attr("dir","rtl"),e.params.autoDarkTheme&&e.enableAutoDarkTheme(),e.root.addClass("framework7-root"),$("html").removeClass("ios md").addClass(e.theme),Utils.nextFrame(function(){e.root.removeClass("framework7-initializing")}),e.initialized=!0,e.emit("init"),e)},t.prototype.loadModule=function(){for(var e=[],a=arguments.length;a--;)e[a]=arguments[a];return t.loadModule.apply(t,e)},t.prototype.loadModules=function(){for(var e=[],a=arguments.length;a--;)e[a]=arguments[a];return t.loadModules.apply(t,e)},t.prototype.getVnodeHooks=function(e,t){return this.vnodeHooks&&this.vnodeHooks[e]&&this.vnodeHooks[e][t]||[]},a.$.get=function(){return $},a.t7.get=function(){return Template7},r.Dom7.get=function(){return $},r.$.get=function(){return $},r.Template7.get=function(){return Template7},r.Class.get=function(){return e},r.Events.get=function(){return EventsClass},Object.defineProperties(t.prototype,a),Object.defineProperties(t,r),t}(Framework7Class);Framework7.ModalMethods=ModalMethods,Framework7.ConstructorMethods=ConstructorMethods,Framework7.loadModule=loadModule,Framework7.loadModules=function(e){return Promise.all(e.map(function(e){return Framework7.loadModule(e)}))};var DeviceModule={name:"device",proto:{device:Device},static:{device:Device},on:{init:function(){var e=[],t=doc.querySelector("html"),a=doc.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]');if(t){if(Device.standalone&&Device.ios&&a&&"black-translucent"===a.content&&e.push("device-full-viewport"),e.push("device-pixel-ratio-"+Math.floor(Device.pixelRatio)),Device.pixelRatio>=2&&e.push("device-retina"),Device.os&&!Device.desktop){if(e.push("device-"+Device.os,"device-"+Device.os+"-"+Device.osVersion.split(".")[0],"device-"+Device.os+"-"+Device.osVersion.replace(/\./g,"-")),"ios"===Device.os){for(var r=parseInt(Device.osVersion.split(".")[0],10)-1;r>=6;r-=1)e.push("device-ios-gt-"+r);Device.iphoneX&&e.push("device-iphone-x")}}else Device.desktop&&(e.push("device-desktop"),Device.os&&e.push("device-"+Device.os));(Device.cordova||Device.phonegap)&&e.push("device-cordova"),e.forEach(function(e){t.classList.add(e)})}}}},SupportModule={name:"support",proto:{support:Support},static:{support:Support},on:{init:function(){var e=doc.querySelector("html");if(e){[].forEach(function(t){e.classList.add(t)})}}}},UtilsModule={name:"utils",proto:{utils:Utils},static:{utils:Utils}},ResizeModule={name:"resize",instance:{getSize:function(){if(!this.root[0])return{width:0,height:0,left:0,top:0};var e=this.root.offset(),t=[this.root[0].offsetWidth,this.root[0].offsetHeight,e.left,e.top],a=t[0],r=t[1],i=t[2],n=t[3];return this.width=a,this.height=r,this.left=i,this.top=n,{width:a,height:r,left:i,top:n}}},on:{init:function(){var e=this;e.getSize(),win.addEventListener("resize",function(){e.emit("resize")},!1),win.addEventListener("orientationchange",function(){e.emit("orientationchange")})},orientationchange:function(){this.device.ipad&&(doc.body.scrollLeft=0,setTimeout(function(){doc.body.scrollLeft=0},0))},resize:function(){this.getSize()}}},globals={},jsonpRequests=0;function Request(e){var t=Utils.extend({},globals);"beforeCreate beforeOpen beforeSend error complete success statusCode".split(" ").forEach(function(e){delete t[e]});var a=Utils.extend({url:win.location.toString(),method:"GET",data:!1,async:!0,cache:!0,user:"",password:"",headers:{},xhrFields:{},statusCode:{},processData:!0,dataType:"text",contentType:"application/x-www-form-urlencoded",timeout:0},t),r=Utils.extend({},a,e);function i(e){for(var t,a,i=[],n=arguments.length-1;n-- >0;)i[n]=arguments[n+1];return globals[e]&&(t=globals[e].apply(globals,i)),r[e]&&(a=r[e].apply(r,i)),"boolean"!=typeof t&&(t=!0),"boolean"!=typeof a&&(a=!0),t&&a}if(!1!==i("beforeCreate",r)){r.type&&(r.method=r.type);var n,s=r.url.indexOf("?")>=0?"&":"?",o=r.method.toUpperCase();if(("GET"===o||"HEAD"===o||"OPTIONS"===o||"DELETE"===o)&&r.data)(n="string"==typeof r.data?r.data.indexOf("?")>=0?r.data.split("?")[1]:r.data:Utils.serializeObject(r.data)).length&&(r.url+=s+n,"?"===s&&(s="&"));if("json"===r.dataType&&r.url.indexOf("callback=")>=0){var l,p="f7jsonp_"+(Date.now()+(jsonpRequests+=1)),c=r.url.split("callback="),d=c[0]+"callback="+p;if(c[1].indexOf("&")>=0){var u=c[1].split("&").filter(function(e){return e.indexOf("=")>0}).join("&");u.length>0&&(d+="&"+u)}var h=doc.createElement("script");return h.type="text/javascript",h.onerror=function(){clearTimeout(l),i("error",null,"scripterror"),i("complete",null,"scripterror")},h.src=d,win[p]=function(e){clearTimeout(l),i("success",e),h.parentNode.removeChild(h),h=null,delete win[p]},doc.querySelector("head").appendChild(h),void(r.timeout>0&&(l=setTimeout(function(){h.parentNode.removeChild(h),h=null,i("error",null,"timeout")},r.timeout)))}"GET"!==o&&"HEAD"!==o&&"OPTIONS"!==o&&"DELETE"!==o||!1===r.cache&&(r.url+=s+"_nocache"+Date.now());var f=new XMLHttpRequest;if(f.requestUrl=r.url,f.requestParameters=r,!1===i("beforeOpen",f,r))return f;f.open(o,r.url,r.async,r.user,r.password);var v,m=null;if(("POST"===o||"PUT"===o||"PATCH"===o)&&r.data)if(r.processData)if([ArrayBuffer,Blob,Document,FormData].indexOf(r.data.constructor)>=0)m=r.data;else{var g="---------------------------"+Date.now().toString(16);"multipart/form-data"===r.contentType?f.setRequestHeader("Content-Type","multipart/form-data; boundary="+g):f.setRequestHeader("Content-Type",r.contentType),m="";var b=Utils.serializeObject(r.data);if("multipart/form-data"===r.contentType){b=b.split("&");for(var y=[],w=0;w<b.length;w+=1)y.push('Content-Disposition: form-data; name="'+b[w].split("=")[0]+'"\r\n\r\n'+b[w].split("=")[1]+"\r\n");m="--"+g+"\r\n"+y.join("--"+g+"\r\n")+"--"+g+"--\r\n"}else m="application/json"===r.contentType?JSON.stringify(r.data):b}else m=r.data,f.setRequestHeader("Content-Type",r.contentType);return"json"!==r.dataType||r.headers&&r.headers.Accept||f.setRequestHeader("Accept","application/json"),r.headers&&Object.keys(r.headers).forEach(function(e){f.setRequestHeader(e,r.headers[e])}),void 0===r.crossDomain&&(r.crossDomain=/^([\w-]+:)?\/\/([^\/]+)/.test(r.url)&&RegExp.$2!==win.location.host),r.crossDomain||f.setRequestHeader("X-Requested-With","XMLHttpRequest"),r.xhrFields&&Utils.extend(f,r.xhrFields),f.onload=function(){var e;if(v&&clearTimeout(v),f.status>=200&&f.status<300||0===f.status)if("json"===r.dataType){var t;try{e=JSON.parse(f.responseText)}catch(e){t=!0}t?i("error",f,"parseerror"):i("success",e,f.status,f)}else i("success",e="text"===f.responseType||""===f.responseType?f.responseText:f.response,f.status,f);else i("error",f,f.status);r.statusCode&&(globals.statusCode&&globals.statusCode[f.status]&&globals.statusCode[f.status](f),r.statusCode[f.status]&&r.statusCode[f.status](f)),i("complete",f,f.status)},f.onerror=function(){v&&clearTimeout(v),i("error",f,f.status),i("complete",f,"error")},r.timeout>0&&(f.onabort=function(){v&&clearTimeout(v)},v=setTimeout(function(){f.abort(),i("error",f,"timeout"),i("complete",f,"timeout")},r.timeout)),!1===i("beforeSend",f,r)?f:(f.send(m),f)}}function RequestShortcut(e){for(var t,a,r=[],i=arguments.length-1;i-- >0;)r[i]=arguments[i+1];var n=[],s=n[0],o=n[1],l=n[2],p=n[3],c=n[4];"function"==typeof r[1]?(s=(t=r)[0],l=t[1],p=t[2],c=t[3]):(s=(a=r)[0],o=a[1],l=a[2],p=a[3],c=a[4]),[l,p].forEach(function(e){"string"==typeof e&&(c=e,e===l?l=void 0:p=void 0)});var d={url:s,method:"post"===e||"postJSON"===e?"POST":"GET",data:o,success:l,error:p,dataType:c=c||("json"===e||"postJSON"===e?"json":void 0)};return"postJSON"===e&&Utils.extend(d,{contentType:"application/json",processData:!1,crossDomain:!0,data:"string"==typeof o?o:JSON.stringify(o)}),Request(d)}function RequestShortcutPromise(e){for(var t=[],a=arguments.length-1;a-- >0;)t[a]=arguments[a+1];var r=t[0],i=t[1],n=t[2];return new Promise(function(t,a){RequestShortcut(e,r,i,function(e){t(e)},function(e,t){a(t)},n)})}Object.assign(Request,{get:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["get"].concat(e))},post:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["post"].concat(e))},json:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["json"].concat(e))},getJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["json"].concat(e))},postJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcut.apply(void 0,["postJSON"].concat(e))}}),Request.promise=function(e){return new Promise(function(t,a){Request(Object.assign(e,{success:function(e){t(e)},error:function(e,t){a(t)}}))})},Object.assign(Request.promise,{get:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["get"].concat(e))},post:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["post"].concat(e))},json:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["json"].concat(e))},getJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["json"].concat(e))},postJSON:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return RequestShortcutPromise.apply(void 0,["postJSON"].concat(e))}}),Request.setup=function(e){e.type&&!e.method&&Utils.extend(e,{method:e.type}),Utils.extend(globals,e)};var RequestModule={name:"request",proto:{request:Request},static:{request:Request}};function initTouch(){var e,t,a,r,i,n,s,o,l,p,c,d,u,h,f,v,m,g,b,y=this,w=y.params.touch,C=w[y.theme+"TouchRipple"];function x(e){var t,a=$(e),r=a.parents(w.activeStateElements);if(a.is(w.activeStateElements)&&(t=a),r.length>0&&(t=t?t.add(r):r),t&&t.length>1){for(var i,n=[],s=0;s<t.length;s+=1)i||(n.push(t[s]),(t.eq(s).hasClass("prevent-active-state-propagation")||t.eq(s).hasClass("no-active-state-propagation"))&&(i=!0));t=$(n)}return t||a}function k(e){return e.parents(".page-content").length>0}function E(){u&&u.addClass("active-state")}function S(){u&&(u.removeClass("active-state"),u=null)}function T(e,t,a){e&&(m=y.touchRipple.create(e,t,a))}function M(){m&&(m.remove(),m=void 0,g=void 0)}function P(a){(g=function(e){var t=w.touchRippleElements,a=$(e);if(a.is(t))return!a.hasClass("no-ripple")&&a;if(a.parents(t).length>0){var r=a.parents(t).eq(0);return!r.hasClass("no-ripple")&&r}return!1}(a))&&0!==g.length?(w.fastClicks?function(e){var t=e.parents(".page-content");return 0!==t.length&&("yes"!==t.prop("scrollHandlerSet")&&(t.on("scroll",function(){clearTimeout(h),clearTimeout(b)}),t.prop("scrollHandlerSet","yes")),!0)}(g):k(g))?(clearTimeout(b),b=setTimeout(function(){M(),T(g,e,t)},80)):(M(),T(g,e,t)):g=void 0}function O(){clearTimeout(b),M()}function D(){m||!g||l?M():(clearTimeout(b),T(g,e,t),setTimeout(M,0))}function I(e,t){y.emit({events:e,data:[t]})}function R(e){I("touchstart touchstart:active",e)}function B(e){I("touchmove touchmove:active",e)}function L(e){I("touchend touchend:active",e)}function A(e){I("touchstart:passive",e)}function z(e){I("touchmove:passive",e)}function H(e){I("touchend:passive",e)}Device.ios&&Device.webView&&win.addEventListener("touchstart",function(){});var U=!!Support.passiveListener&&{passive:!0},N=!!Support.passiveListener&&{passive:!1};doc.addEventListener("click",function(e){I("click",e)},!0),Support.passiveListener?(doc.addEventListener(y.touchEvents.start,R,N),doc.addEventListener(y.touchEvents.move,B,N),doc.addEventListener(y.touchEvents.end,L,N),doc.addEventListener(y.touchEvents.start,A,U),doc.addEventListener(y.touchEvents.move,z,U),doc.addEventListener(y.touchEvents.end,H,U)):(doc.addEventListener(y.touchEvents.start,function(e){R(e),A(e)},!1),doc.addEventListener(y.touchEvents.move,function(e){B(e),z(e)},!1),doc.addEventListener(y.touchEvents.end,function(e){L(e),H(e)},!1)),Support.touch?(w.fastClicks?(y.on("click",function(e){var t,a,n=!1;return i?(r=null,i=!1,!0):"submit"===e.target.type&&0===e.detail||"file"===e.target.type||(r||(t=e.target,a="input select textarea label".split(" "),t.nodeName&&a.indexOf(t.nodeName.toLowerCase())>=0||(n=!0)),f||(n=!0),doc.activeElement===r&&(n=!0),e.forwardedTouchEvent&&(n=!0),e.cancelable||(n=!0),w.tapHold&&w.tapHoldPreventClicks&&p&&(n=!1),n||(e.stopImmediatePropagation(),e.stopPropagation(),r?(function(e){var t=$(e),a=!0;return(t.is("label")||t.parents("label").length>0)&&(a=!Device.android&&!(!Device.ios||!t.is("input"))),a}(r)||l)&&e.preventDefault():e.preventDefault(),r=null),v=setTimeout(function(){f=!1},Device.ios||Device.androidChrome?100:400),w.tapHold&&(c=setTimeout(function(){p=!1},Device.ios||Device.androidChrome?100:400)),n)}),y.on("touchstart",function(d){var m,g,b=this;if(l=!1,p=!1,d.targetTouches.length>1)return u&&S(),!0;if(d.touches.length>1&&u&&S(),w.tapHold&&(c&&clearTimeout(c),c=setTimeout(function(){d&&d.touches&&d.touches.length>1||(p=!0,d.preventDefault(),$(d.target).trigger("taphold"))},w.tapHoldDelay)),v&&clearTimeout(v),m=d.target,g=$(m),!(f=!("input"===m.nodeName.toLowerCase()&&("file"===m.type||"range"===m.type)||"select"===m.nodeName.toLowerCase()&&Device.android||g.hasClass("no-fastclick")||g.parents(".no-fastclick").length>0||w.fastClicksExclude&&g.closest(w.fastClicksExclude).length>0)))return i=!1,!0;if(Device.ios||Device.android&&"getSelection"in win){var y=win.getSelection();if(y.rangeCount&&y.focusNode!==doc.body&&(!y.isCollapsed||doc.activeElement===y.focusNode))return n=!0,!0;n=!1}return Device.android&&function(e){var t="button input textarea select".split(" ");return!(!doc.activeElement||e===doc.activeElement||doc.activeElement===doc.body||t.indexOf(e.nodeName.toLowerCase())>=0)}(d.target)&&doc.activeElement.blur(),i=!0,r=d.target,a=(new Date).getTime(),e=d.targetTouches[0].pageX,t=d.targetTouches[0].pageY,Device.ios&&(s=void 0,$(r).parents().each(function(){var e=b;e.scrollHeight>e.offsetHeight&&!s&&((s=e).f7ScrollTop=s.scrollTop)})),a-o<w.fastClicksDelayBetweenClicks&&d.preventDefault(),w.activeState&&(u=x(r),h=setTimeout(E,0)),C&&P(r),!0}),y.on("touchmove",function(a){if(i){var n=w.fastClicksDistanceThreshold;if(n){var s=a.targetTouches[0].pageX,o=a.targetTouches[0].pageY;(Math.abs(s-e)>n||Math.abs(o-t)>n)&&(l=!0)}else l=!0;l&&(i=!1,r=null,l=!0,w.tapHold&&clearTimeout(c),w.activeState&&(clearTimeout(h),S()),C&&O())}}),y.on("touchend",function(e){clearTimeout(h),clearTimeout(c);var t=(new Date).getTime();if(!i)return!n&&f&&(Device.android&&!e.cancelable||!e.cancelable||e.preventDefault()),w.activeState&&S(),C&&D(),!0;if(doc.activeElement===e.target)return w.activeState&&S(),C&&D(),!0;if(n||e.preventDefault(),t-o<w.fastClicksDelayBetweenClicks)return setTimeout(S,0),C&&D(),!0;if(o=t,i=!1,Device.ios&&s&&s.scrollTop!==s.f7ScrollTop)return!1;if(w.activeState&&(E(),setTimeout(S,0)),C&&D(),function(e){if(doc.activeElement===e)return!1;var t=e.nodeName.toLowerCase(),a="button checkbox file image radio submit".split(" ");return!e.disabled&&!e.readOnly&&("textarea"===t||("select"===t?!Device.android:"input"===t&&a.indexOf(e.type)<0))}(r)){if(Device.ios&&Device.webView)return r.focus(),!1;r.focus()}return doc.activeElement&&r!==doc.activeElement&&doc.activeElement!==doc.body&&"label"!==r.nodeName.toLowerCase()&&doc.activeElement.blur(),e.preventDefault(),!(w.tapHoldPreventClicks&&p||(function(e){var t=e.changedTouches[0],a=doc.createEvent("MouseEvents"),i="click";Device.android&&"select"===r.nodeName.toLowerCase()&&(i="mousedown"),a.initMouseEvent(i,!0,!0,win,1,t.screenX,t.screenY,t.clientX,t.clientY,!1,!1,!1,!1,0,null),a.forwardedTouchEvent=!0,y.device.ios&&win.navigator.standalone?setTimeout(function(){(r=doc.elementFromPoint(e.changedTouches[0].clientX,e.changedTouches[0].clientY))&&r.dispatchEvent(a)},10):r.dispatchEvent(a)}(e),1))})):(y.on("click",function(e){var t=e&&e.detail&&"f7Overswipe"===e.detail,a=d;return r&&e.target!==r&&(a=!t),w.tapHold&&w.tapHoldPreventClicks&&p&&(a=!0),a&&(e.stopImmediatePropagation(),e.stopPropagation(),e.preventDefault()),w.tapHold&&(c=setTimeout(function(){p=!1},Device.ios||Device.androidChrome?100:400)),d=!1,r=null,!a}),y.on("touchstart",function(a){return l=!1,p=!1,d=!1,a.targetTouches.length>1?(u&&S(),!0):(a.touches.length>1&&u&&S(),w.tapHold&&(c&&clearTimeout(c),c=setTimeout(function(){a&&a.touches&&a.touches.length>1||(p=!0,a.preventDefault(),d=!0,$(a.target).trigger("taphold"))},w.tapHoldDelay)),r=a.target,e=a.targetTouches[0].pageX,t=a.targetTouches[0].pageY,w.activeState&&(k(u=x(r))?h=setTimeout(E,80):E()),C&&P(r),!0)}),y.on("touchmove",function(a){var r,i;if("touchmove"===a.type&&(r=a.targetTouches[0],i=w.touchClicksDistanceThreshold),i&&r){var n=r.pageX,s=r.pageY;(Math.abs(n-e)>i||Math.abs(s-t)>i)&&(l=!0)}else l=!0;l&&(d=!0,w.tapHold&&clearTimeout(c),w.activeState&&(clearTimeout(h),S()),C&&O())}),y.on("touchend",function(e){return clearTimeout(h),clearTimeout(c),doc.activeElement===e.target?(w.activeState&&S(),C&&D(),!0):(w.activeState&&(E(),setTimeout(S,0)),C&&D(),!(w.tapHoldPreventClicks&&p||d)||(e.cancelable&&e.preventDefault(),d=!0,!1))})),doc.addEventListener("touchcancel",function(){i=!1,r=null,clearTimeout(h),clearTimeout(c),w.activeState&&S(),C&&D()},{passive:!0})):w.activeState&&(y.on("touchstart",function(a){x(a.target).addClass("active-state"),"which"in a&&3===a.which&&setTimeout(function(){$(".active-state").removeClass("active-state")},0),C&&(e=a.pageX,t=a.pageY,P(a.target,a.pageX,a.pageY))}),y.on("touchmove",function(){$(".active-state").removeClass("active-state"),C&&O()}),y.on("touchend",function(){$(".active-state").removeClass("active-state"),C&&D()})),doc.addEventListener("contextmenu",function(e){w.disableContextMenu&&(Device.ios||Device.android||Device.cordova)&&e.preventDefault(),C&&(u&&S(),D())})}var TouchModule={name:"touch",params:{touch:{fastClicks:!1,fastClicksDistanceThreshold:10,fastClicksDelayBetweenClicks:50,fastClicksExclude:"",touchClicksDistanceThreshold:5,disableContextMenu:!1,tapHold:!1,tapHoldDelay:750,tapHoldPreventClicks:!0,activeState:!0,activeStateElements:"a, button, label, span, .actions-button, .stepper-button, .stepper-button-plus, .stepper-button-minus, .card-expandable, .menu-item, .link, .item-link",mdTouchRipple:!0,iosTouchRipple:!1,auroraTouchRipple:!1,touchRippleElements:".ripple, .link, .item-link, .list-button, .links-list a, .button, button, .input-clear-button, .dialog-button, .tab-link, .item-radio, .item-checkbox, .actions-button, .searchbar-disable-button, .fab a, .checkbox, .radio, .data-table .sortable-cell:not(.input-cell), .notification-close-button, .stepper-button, .stepper-button-minus, .stepper-button-plus, .menu-item-content"}},instance:{touchEvents:{start:Support.touch?"touchstart":"mousedown",move:Support.touch?"touchmove":"mousemove",end:Support.touch?"touchend":"mouseup"}},on:{init:initTouch}},pathToRegexp_1=pathToRegexp,parse_1=parse,compile_1=compile,tokensToFunction_1=tokensToFunction,tokensToRegExp_1=tokensToRegExp,DEFAULT_DELIMITER="/",PATH_REGEXP=new RegExp(["(\\\\.)","(?:\\:(\\w+)(?:\\(((?:\\\\.|[^\\\\()])+)\\))?|\\(((?:\\\\.|[^\\\\()])+)\\))([+*?])?"].join("|"),"g");function parse(e,t){for(var a,r=[],i=0,n=0,s="",o=t&&t.delimiter||DEFAULT_DELIMITER,l=t&&t.whitelist||void 0,p=!1;null!==(a=PATH_REGEXP.exec(e));){var c=a[0],d=a[1],u=a.index;if(s+=e.slice(n,u),n=u+c.length,d)s+=d[1],p=!0;else{var h="",f=a[2],v=a[3],m=a[4],g=a[5];if(!p&&s.length){var b=s.length-1,y=s[b];(!l||l.indexOf(y)>-1)&&(h=y,s=s.slice(0,b))}s&&(r.push(s),s="",p=!1);var w="+"===g||"*"===g,C="?"===g||"*"===g,x=v||m,$=h||o;r.push({name:f||i++,prefix:h,delimiter:$,optional:C,repeat:w,pattern:x?escapeGroup(x):"[^"+escapeString($===o?$:$+o)+"]+?"})}}return(s||n<e.length)&&r.push(s+e.substr(n)),r}function compile(e,t){return tokensToFunction(parse(e,t))}function tokensToFunction(e){for(var t=new Array(e.length),a=0;a<e.length;a++)"object"==typeof e[a]&&(t[a]=new RegExp("^(?:"+e[a].pattern+")$"));return function(a,r){for(var i="",n=r&&r.encode||encodeURIComponent,s=0;s<e.length;s++){var o=e[s];if("string"!=typeof o){var l,p=a?a[o.name]:void 0;if(Array.isArray(p)){if(!o.repeat)throw new TypeError('Expected "'+o.name+'" to not repeat, but got array');if(0===p.length){if(o.optional)continue;throw new TypeError('Expected "'+o.name+'" to not be empty')}for(var c=0;c<p.length;c++){if(l=n(p[c],o),!t[s].test(l))throw new TypeError('Expected all "'+o.name+'" to match "'+o.pattern+'"');i+=(0===c?o.prefix:o.delimiter)+l}}else if("string"!=typeof p&&"number"!=typeof p&&"boolean"!=typeof p){if(!o.optional)throw new TypeError('Expected "'+o.name+'" to be '+(o.repeat?"an array":"a string"))}else{if(l=n(String(p),o),!t[s].test(l))throw new TypeError('Expected "'+o.name+'" to match "'+o.pattern+'", but got "'+l+'"');i+=o.prefix+l}}else i+=o}return i}}function escapeString(e){return e.replace(/([.+*?=^!:${}()[\]|\/\\])/g,"\\$1")}function escapeGroup(e){return e.replace(/([=!:$\/()])/g,"\\$1")}function flags(e){return e&&e.sensitive?"":"i"}function regexpToRegexp(e,t){if(!t)return e;var a=e.source.match(/\((?!\?)/g);if(a)for(var r=0;r<a.length;r++)t.push({name:r,prefix:null,delimiter:null,optional:!1,repeat:!1,pattern:null});return e}function arrayToRegexp(e,t,a){for(var r=[],i=0;i<e.length;i++)r.push(pathToRegexp(e[i],t,a).source);return new RegExp("(?:"+r.join("|")+")",flags(a))}function stringToRegexp(e,t,a){return tokensToRegExp(parse(e,a),t,a)}function tokensToRegExp(e,t,a){for(var r=(a=a||{}).strict,i=!1!==a.start,n=!1!==a.end,s=a.delimiter||DEFAULT_DELIMITER,o=[].concat(a.endsWith||[]).map(escapeString).concat("$").join("|"),l=i?"^":"",p=0;p<e.length;p++){var c=e[p];if("string"==typeof c)l+=escapeString(c);else{var d=c.repeat?"(?:"+c.pattern+")(?:"+escapeString(c.delimiter)+"(?:"+c.pattern+"))*":c.pattern;t&&t.push(c),c.optional?c.prefix?l+="(?:"+escapeString(c.prefix)+"("+d+"))?":l+="("+d+")?":l+=escapeString(c.prefix)+"("+d+")"}}if(n)r||(l+="(?:"+escapeString(s)+")?"),l+="$"===o?"$":"(?="+o+")";else{var u=e[e.length-1],h="string"==typeof u?u[u.length-1]===s:void 0===u;r||(l+="(?:"+escapeString(s)+"(?="+o+"))?"),h||(l+="(?="+escapeString(s)+"|"+o+")")}return new RegExp(l,flags(a))}function pathToRegexp(e,t,a){return e instanceof RegExp?regexpToRegexp(e,t):Array.isArray(e)?arrayToRegexp(e,t,a):stringToRegexp(e,t,a)}pathToRegexp_1.parse=parse_1,pathToRegexp_1.compile=compile_1,pathToRegexp_1.tokensToFunction=tokensToFunction_1,pathToRegexp_1.tokensToRegExp=tokensToRegExp_1;var History={queue:[],clearQueue:function(){0!==History.queue.length&&History.queue.shift()()},routerQueue:[],clearRouterQueue:function(){if(0!==History.routerQueue.length){var e=History.routerQueue.pop(),t=e.router,a=e.stateUrl,r=e.action,i=t.params.animate;!1===t.params.pushStateAnimate&&(i=!1),"back"===r&&t.back({animate:i,pushState:!1}),"load"===r&&t.navigate(a,{animate:i,pushState:!1})}},handle:function(e){if(!History.blockPopstate){var t=e.state;History.previousState=History.state,History.state=t,History.allowChange=!0,History.clearQueue(),(t=History.state)||(t={}),this.views.forEach(function(e){var a=e.router,r=t[e.id];if(!r&&e.params.pushState&&(r={url:e.router.history[0]}),r){var i=r.url||void 0,n=a.params.animate;!1===a.params.pushStateAnimate&&(n=!1),i!==a.url&&(a.history.indexOf(i)>=0?a.allowPageChange?a.back({animate:n,pushState:!1}):History.routerQueue.push({action:"back",router:a}):a.allowPageChange?a.navigate(i,{animate:n,pushState:!1}):History.routerQueue.unshift({action:"load",stateUrl:i,router:a}))}})}},initViewState:function(e,t){var a,r=Utils.extend({},History.state||{},((a={})[e]=t,a));History.state=r,win.history.replaceState(r,"")},push:function(e,t,a){var r;if(History.allowChange){History.previousState=History.state;var i=Utils.extend({},History.previousState||{},((r={})[e]=t,r));History.state=i,win.history.pushState(i,"",a)}else History.queue.push(function(){History.push(e,t,a)})},replace:function(e,t,a){var r;if(History.allowChange){History.previousState=History.state;var i=Utils.extend({},History.previousState||{},((r={})[e]=t,r));History.state=i,win.history.replaceState(i,"",a)}else History.queue.push(function(){History.replace(e,t,a)})},go:function(e){History.allowChange=!1,win.history.go(e)},back:function(){History.allowChange=!1,win.history.back()},allowChange:!0,previousState:{},state:win.history.state,blockPopstate:!0,init:function(e){$(win).on("load",function(){setTimeout(function(){History.blockPopstate=!1},0)}),doc.readyState&&"complete"===doc.readyState&&(History.blockPopstate=!1),$(win).on("popstate",History.handle.bind(e))}};function SwipeBack(e){var t,a,r,i,n,s,o,l,p,c,d=e,u=d.$el,h=d.$navbarEl,f=d.app,v=d.params,m=!1,g=!1,b={},y=[],w=[],C=!0,x=[],k=[],E=v[f.theme+"SwipeBackAnimateShadow"],S=v[f.theme+"SwipeBackAnimateOpacity"],T=v[f.theme+"SwipeBackActiveArea"],M=v[f.theme+"SwipeBackThreshold"],P=f.rtl?"right center":"left center";function O(e){void 0===e&&(e={});for(var t=e.progress,a=e.reset,r=e.transition,i=["overflow","transform","transform-origin","opacity"],n=0;n<p.length;n+=1){var s=p[n];if(s&&s.el){!0===r&&s.el.classList.add("navbar-page-transitioning"),!1===r&&s.el.classList.remove("navbar-page-transitioning");for(var o=0;o<i.length;o+=1){var l=i[o];s[l]&&(a?s.el.style[l]="":"function"==typeof s[l]?s.el.style[l]=s[l](t):s.el.style[l]=s[l])}}}}function D(e){var a=v[f.theme+"SwipeBack"];!C||!a||m||f.swipeout&&f.swipeout.el||!d.allowPageChange||$(e.target).closest(".range-slider, .calendar-months").length>0||$(e.target).closest(".page-master, .page-master-detail").length>0&&v.masterDetailBreakpoint>0&&f.width>=v.masterDetailBreakpoint||(g=!1,m=!0,t=void 0,b.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,b.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,i=Utils.now(),n=d.dynamicNavbar,s=d.separateNavbar)}function I(e){if(m){var i="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,c="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;if(void 0===t&&(t=!!(t||Math.abs(c-b.y)>Math.abs(i-b.x))||i<b.x&&!f.rtl||i>b.x&&f.rtl),t||e.f7PreventSwipeBack||f.preventSwipeBack)m=!1;else{if(!g){var C=!1,D=$(e.target),I=D.closest(".swipeout");I.length>0&&(!f.rtl&&I.find(".swipeout-actions-left").length>0&&(C=!0),f.rtl&&I.find(".swipeout-actions-right").length>0&&(C=!0)),((y=D.closest(".page")).hasClass("no-swipeback")||D.closest(".no-swipeback, .card-opened").length>0)&&(C=!0),(w=u.find(".page-previous:not(.stacked)")).length>1&&(w=w.eq(w.length-1));b.x,u.offset().left;if(a=u.width(),(f.rtl?b.x<u.offset().left-u[0].scrollLeft+(a-T):b.x-u.offset().left>T)&&(C=!0),0!==w.length&&0!==y.length||(C=!0),C)return void(m=!1);E&&0===(o=y.find(".page-shadow-effect")).length&&(o=$('<div class="page-shadow-effect"></div>'),y.append(o)),S&&0===(l=w.find(".page-opacity-effect")).length&&(l=$('<div class="page-opacity-effect"></div>'),w.append(l)),n&&(s?(x=h.find(".navbar-current:not(.stacked)"),k=h.find(".navbar-previous:not(.stacked)")):(x=y.children(".navbar").children(".navbar-inner"),k=w.children(".navbar").children(".navbar-inner")),k.length>1&&(k=k.eq(k.length-1)),p=function(){var e,t,a=[],r=f.rtl?-1:1,i=x.hasClass("navbar-inner-large"),n=k.hasClass("navbar-inner-large"),o=i&&!x.hasClass("navbar-inner-large-collapsed"),l=n&&!k.hasClass("navbar-inner-large-collapsed"),p=x.children(".left, .title, .right, .subnavbar, .fading, .title-large"),c=k.children(".left, .title, .right, .subnavbar, .fading, .title-large");return v.iosAnimateNavbarBackIcon&&(e=x.hasClass("sliding")?x.children(".left").find(".back .icon + span").eq(0):x.children(".left.sliding").find(".back .icon + span").eq(0),t=k.hasClass("sliding")?k.children(".left").find(".back .icon + span").eq(0):k.children(".left.sliding").find(".back .icon + span").eq(0),e.length&&c.each(function(t,a){$(a).hasClass("title")&&(a.f7NavbarLeftOffset+=e.prev(".icon")[0].offsetWidth)})),p.each(function(t,n){var p=$(n),c=p.hasClass("subnavbar"),d=p.hasClass("left"),u=p.hasClass("title");if(o||!p.hasClass(".title-large")){var h={el:n};if(o){if(u)return;if(p.hasClass("title-large")){if(!s)return;return void(l?(a.indexOf(h)<0&&a.push(h),h.overflow="visible",h.transform="translateX(100%)",p.find(".title-large-text, .title-large-inner").each(function(e,t){a.push({el:t,transform:function(e){return"translateX("+(100*e*r-100)+"%)"}})})):(a.indexOf(h)<0&&a.push(h),h.overflow="hidden",h.transform=function(e){return"translateY(calc("+-e+" * var(--f7-navbar-large-title-height)))"},p.find(".title-large-text, .title-large-inner").each(function(e,t){a.push({el:t,transform:function(e){return"translateX("+100*e*r+"%) translateY(calc("+e+" * var(--f7-navbar-large-title-height)))"}})})))}}if(l){if(!o&&p.hasClass("title-large")){if(!s)return;a.indexOf(h)<0&&a.push(h),h.opacity=0}if(d&&s)return a.indexOf(h)<0&&a.push(h),h.opacity=function(e){return 1-Math.pow(e,.33)},void p.find(".back span").each(function(e,t){a.push({el:t,"transform-origin":P,transform:function(e){return"translateY(calc(var(--f7-navbar-height) * "+e+")) scale("+(1+1*e)+")"}})})}if(!p.hasClass("title-large")){var f=p.hasClass("sliding")||x.hasClass("sliding");if(a.indexOf(h)<0&&a.push(h),(!c||c&&!f)&&(h.opacity=function(e){return 1-Math.pow(e,.33)}),f){var m=h;if(d&&e.length&&v.iosAnimateNavbarBackIcon){var g={el:e[0]};m=g,a.push(g)}m.transform=function(e){var t=e*m.el.f7NavbarRightOffset;return 1===Device.pixelRatio&&(t=Math.round(t)),c&&i&&s?"translate3d("+t+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)":"translate3d("+t+"px,0,0)"}}}}}),c.each(function(e,i){var p=$(i),c=p.hasClass("subnavbar"),d=p.hasClass("left"),u=p.hasClass("title"),h={el:i};if(l){if(u)return;if(a.indexOf(h)<0&&a.push(h),p.hasClass("title-large")){if(!s)return;return o?(h.opacity=1,h.overflow="visible",h.transform="translateY(0)",p.find(".title-large-text").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"translateY(calc("+(1*e-1)+" * var(--f7-navbar-large-title-height))) scale("+(.5+.5*e)+")"}})})):(h.transform=function(e){return"translateY(calc("+(e-1)+" * var(--f7-navbar-large-title-height)))"},h.opacity=1,h.overflow="hidden",p.find(".title-large-text").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"scale("+(.5+.5*e)+")"}})})),void p.find(".title-large-inner").each(function(e,t){a.push({el:t,"transform-origin":P,opacity:function(e){return Math.pow(e,3)},transform:function(e){return"translateX("+-100*(1-e)*r+"%)"}})})}}if(!p.hasClass("title-large")){var f=p.hasClass("sliding")||k.hasClass("sliding");if(a.indexOf(h)<0&&a.push(h),(!c||c&&!f)&&(h.opacity=function(e){return Math.pow(e,3)}),f){var m=h;if(d&&t.length&&v.iosAnimateNavbarBackIcon){var g={el:t[0]};m=g,a.push(g)}m.transform=function(e){var t=m.el.f7NavbarLeftOffset*(1-e);return 1===Device.pixelRatio&&(t=Math.round(t)),c&&n&&s?"translate3d("+t+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)":"translate3d("+t+"px,0,0)"}}}}),a}()),$(".sheet.modal-in").length>0&&f.sheet&&f.sheet.close($(".sheet.modal-in"))}e.f7PreventPanelSwipe=!0,g=!0,f.preventSwipePanelBySwipeBack=!0,e.preventDefault();var R=f.rtl?-1:1;(r=(i-b.x-M)*R)<0&&(r=0);var B=Math.min(Math.max(r/a,0),1),L={percentage:B,progress:B,currentPageEl:y[0],previousPageEl:w[0],currentNavbarEl:x[0],previousNavbarEl:k[0]};u.trigger("swipeback:move",L),d.emit("swipebackMove",L);var A=r*R,z=(r/5-a/5)*R;f.rtl?(A=Math.max(A,-a),z=Math.max(z,0)):(A=Math.min(A,a),z=Math.min(z,0)),1===Device.pixelRatio&&(A=Math.round(A),z=Math.round(z)),d.swipeBackActive=!0,$([y[0],w[0]]).addClass("page-swipeback-active"),y.transform("translate3d("+A+"px,0,0)"),E&&(o[0].style.opacity=1-1*B),"ios"===f.theme&&w.transform("translate3d("+z+"px,0,0)"),S&&(o[0].style.opacity=1-1*B),n&&O({progress:B})}}}function R(){if(f.preventSwipePanelBySwipeBack=!1,!m||!g)return m=!1,void(g=!1);if(m=!1,g=!1,d.swipeBackActive=!1,$([y[0],w[0]]).removeClass("page-swipeback-active"),0===r)return $([y[0],w[0]]).transform(""),o&&o.length>0&&o.remove(),l&&l.length>0&&l.remove(),void(n&&O({reset:!0}));var e=Utils.now()-i,t=!1;(e<300&&r>10||e>=300&&r>a/2)&&(y.removeClass("page-current").addClass("page-next"+("ios"!==f.theme?" page-next-on-right":"")),w.removeClass("page-previous").addClass("page-current").removeAttr("aria-hidden"),o&&(o[0].style.opacity=""),l&&(l[0].style.opacity=""),n&&(x.removeClass("navbar-current").addClass("navbar-next"),k.removeClass("navbar-previous").addClass("navbar-current").removeAttr("aria-hidden")),t=!0),$([y[0],w[0]]).addClass("page-transitioning page-transitioning-swipeback").transform(""),n&&O({progress:t?1:0,transition:!0}),C=!1,d.allowPageChange=!1;var p={currentPageEl:y[0],previousPageEl:w[0],currentNavbarEl:x[0],previousNavbarEl:k[0]};t?(d.currentRoute=w[0].f7Page.route,d.currentPage=w[0],d.pageCallback("beforeOut",y,x,"current","next",{route:y[0].f7Page.route,swipeBack:!0}),d.pageCallback("beforeIn",w,k,"previous","current",{route:w[0].f7Page.route,swipeBack:!0},y[0]),u.trigger("swipeback:beforechange",p),d.emit("swipebackBeforeChange",p)):(u.trigger("swipeback:beforereset",p),d.emit("swipebackBeforeReset",p)),y.transitionEnd(function(){$([y[0],w[0]]).removeClass("page-transitioning page-transitioning-swipeback"),n&&O({reset:!0,transition:!1}),C=!0,d.allowPageChange=!0,t?(1===d.history.length&&d.history.unshift(d.url),d.history.pop(),d.saveHistory(),v.pushState&&History.back(),d.pageCallback("afterOut",y,x,"current","next",{route:y[0].f7Page.route,swipeBack:!0}),d.pageCallback("afterIn",w,k,"previous","current",{route:w[0].f7Page.route,swipeBack:!0}),v.stackPages&&d.initialPages.indexOf(y[0])>=0?(y.addClass("stacked"),s&&x.addClass("stacked")):(d.pageCallback("beforeRemove",y,x,"next",{swipeBack:!0}),d.removePage(y),s&&d.removeNavbar(x)),u.trigger("swipeback:afterchange",p),d.emit("swipebackAfterChange",p),d.emit("routeChanged",d.currentRoute,d.previousRoute,d),v.preloadPreviousPage&&d.back(d.history[d.history.length-2],{preload:!0})):(u.trigger("swipeback:afterreset",p),d.emit("swipebackAfterReset",p)),o&&o.length>0&&o.remove(),l&&l.length>0&&l.remove()})}c=!("touchstart"!==f.touchEvents.start||!Support.passiveListener)&&{passive:!0,capture:!1},u.on(f.touchEvents.start,D,c),f.on("touchmove:active",I),f.on("touchend:passive",R),d.on("routerDestroy",function(){var e=!("touchstart"!==f.touchEvents.start||!Support.passiveListener)&&{passive:!0,capture:!1};u.off(f.touchEvents.start,D,e),f.off("touchmove:active",I),f.off("touchend:passive",R)})}function redirect(e,t,a){var r=this,i=t.route.redirect;if(a.initial&&r.params.pushState&&(a.replaceState=!0,a.history=!0),"function"==typeof i){r.allowPageChange=!1;var n=i.call(r,t,function(t,i){void 0===i&&(i={}),r.allowPageChange=!0,r[e](t,Utils.extend({},a,i))},function(){r.allowPageChange=!0});return n&&"string"==typeof n?(r.allowPageChange=!0,r[e](n,a)):r}return r[e](i,a)}function processQueue(e,t,a,r,i,n,s){var o=[];Array.isArray(a)?o.push.apply(o,a):a&&"function"==typeof a&&o.push(a),t&&(Array.isArray(t)?o.push.apply(o,t):o.push(t)),function t(){0!==o.length?o.shift().call(e,r,i,function(){t()},function(){s()}):n()}()}function processRouteQueue(e,t,a,r){var i=this;function n(){e&&e.route&&(i.params.routesBeforeEnter||e.route.beforeEnter)?(i.allowPageChange=!1,processQueue(i,i.params.routesBeforeEnter,e.route.beforeEnter,e,t,function(){i.allowPageChange=!0,a()},function(){r()})):a()}t&&t.route&&(i.params.routesBeforeLeave||t.route.beforeLeave)?(i.allowPageChange=!1,processQueue(i,i.params.routesBeforeLeave,t.route.beforeLeave,e,t,function(){i.allowPageChange=!0,n()},function(){r()})):n()}function appRouterCheck(e,t){if(!e.view)throw new Error("Framework7: it is not allowed to use router methods on global app router. Use router methods only on related View, e.g. app.views.main.router."+t+"(...)")}function refreshPage(){return appRouterCheck(this,"refreshPage"),this.navigate(this.currentRoute.url,{ignoreCache:!0,reloadCurrent:!0})}function forward(e,t){void 0===t&&(t={});var a,r,i,n=this,s=$(e),o=n.app,l=n.view,p=Utils.extend(!1,{animate:n.params.animate,pushState:!0,replaceState:!1,history:!0,reloadCurrent:n.params.reloadPages,reloadPrevious:!1,reloadAll:!1,clearPreviousHistory:!1,reloadDetail:n.params.reloadDetail,on:{}},t),c=n.params.masterDetailBreakpoint>0,d=c&&p.route&&p.route.route&&!0===p.route.route.master,u=n.currentRoute.modal;if(u||"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(e){n.currentRoute&&n.currentRoute.route&&n.currentRoute.route[e]&&(u=!0,i=e)}),u){var h=n.currentRoute.modal||n.currentRoute.route.modalInstance||o[i].get(),f=n.history[n.history.length-2],v=n.findMatchingRoute(f);!v&&f&&(v={url:f,path:f.split("?")[0],query:Utils.parseUrlQuery(f),route:{path:f.split("?")[0],url:f}}),n.modalRemove(h)}var m,g,b,y,w=n.dynamicNavbar,C=n.separateNavbar,x=n.$el,k=s,E=p.reloadPrevious||p.reloadCurrent||p.reloadAll;if(n.allowPageChange=!1,0===k.length)return n.allowPageChange=!0,n;k.length&&n.removeThemeElements(k),w&&(b=k.children(".navbar").children(".navbar-inner"),C&&(g=n.$navbarEl,b.length>0&&k.children(".navbar").remove(),0===b.length&&k[0]&&k[0].f7Page&&(b=k[0].f7Page.$navbarEl))),p.route&&p.route.route&&p.route.route.keepAlive&&!p.route.route.keepAliveData&&(p.route.route.keepAliveData={pageEl:s[0]});var S,T,M,P=x.children(".page:not(.stacked)").filter(function(e,t){return t!==k[0]});if(C&&(S=g.children(".navbar-inner:not(.stacked)").filter(function(e,t){return t!==b[0]})),p.reloadPrevious&&P.length<2)return n.allowPageChange=!0,n;if(c&&!p.reloadAll){for(var O=0;O<P.length;O+=1)a||!P[O].classList.contains("page-master")||(a=P[O]);if((T=!d&&a)&&a)for(var D=0;D<P.length;D+=1)P[D].classList.contains("page-master-detail")&&(r=P[D]);M=T&&p.reloadDetail&&o.width>=n.params.masterDetailBreakpoint&&a}var I="next";if(p.reloadCurrent||p.reloadAll||M?I="current":p.reloadPrevious&&(I="previous"),k.removeClass("page-previous page-current page-next").addClass("page-"+I+(d?" page-master":"")+(T?" page-master-detail":"")).removeClass("stacked").trigger("page:unstack").trigger("page:position",{position:I}),n.emit("pageUnstack",k[0]),n.emit("pagePosition",k[0],I),(d||T)&&k.trigger("page:role",{role:d?"master":"detail"}),w&&b.length&&b.removeClass("navbar-previous navbar-current navbar-next").addClass("navbar-"+I+(d?" navbar-master":"")+(T?" navbar-master-detail":"")).removeClass("stacked"),p.reloadCurrent||M)m=P.eq(P.length-1),C&&(y=$(o.navbar.getElByPage(m)));else if(p.reloadPrevious)m=P.eq(P.length-2),C&&(y=$(o.navbar.getElByPage(m)));else if(p.reloadAll)m=P.filter(function(e,t){return t!==k[0]}),C&&(y=S.filter(function(e,t){return t!==b[0]}));else{if(P.length>1){var R=0;for(R=0;R<P.length-1;R+=1)if(a&&P[R]===a)P.eq(R).addClass("page-master-stacked"),P.eq(R).trigger("page:masterstack"),n.emit("pageMasterStack",P[R]),C&&$(o.navbar.getElByPage(a)).addClass("navbar-master-stacked");else{var B=o.navbar.getElByPage(P.eq(R));n.params.stackPages?(P.eq(R).addClass("stacked"),P.eq(R).trigger("page:stack"),n.emit("pageStack",P[R]),C&&$(B).addClass("stacked")):(n.pageCallback("beforeRemove",P[R],S&&S[R],"previous",void 0,p),n.removePage(P[R]),C&&B&&n.removeNavbar(B))}}m=x.children(".page:not(.stacked)").filter(function(e,t){return t!==k[0]}),C&&(y=g.children(".navbar-inner:not(.stacked)").filter(function(e,t){return t!==b[0]}))}if(w&&!C&&(y=m.children(".navbar").children(".navbar-inner")),T&&!p.reloadAll&&((m.length>1||M)&&(m=m.filter(function(e,t){return!t.classList.contains("page-master")})),y&&(y.length>1||M)&&(y=y.filter(function(e,t){return!t.classList.contains("navbar-master")}))),n.params.pushState&&(p.pushState||p.replaceState)&&!p.reloadPrevious){var L=n.params.pushStateRoot||"";History[p.reloadCurrent||M&&r||p.reloadAll||p.replaceState?"replace":"push"](l.id,{url:p.route.url},L+n.params.pushStateSeparator+p.route.url)}p.reloadPrevious||(n.currentPageEl=k[0],w&&b.length?n.currentNavbarEl=b[0]:delete n.currentNavbarEl,n.currentRoute=p.route);var A=p.route.url;p.history&&(((p.reloadCurrent||M&&r)&&n.history.length)>0||p.replaceState?n.history[n.history.length-(p.reloadPrevious?2:1)]=A:p.reloadPrevious?n.history[n.history.length-2]=A:p.reloadAll?n.history=[A]:n.history.push(A)),n.saveHistory();var z=k.parents(doc).length>0,H=k[0].f7Component;if(p.reloadPrevious?(H&&!z?H.$mount(function(e){$(e).insertBefore(m)}):k.insertBefore(m),C&&b.length&&(b.children(".title-large").length&&b.addClass("navbar-inner-large"),y.length?b.insertBefore(y):(n.$navbarEl.parents(doc).length||n.$el.prepend(n.$navbarEl),g.append(b)))):(m.next(".page")[0]!==k[0]&&(H&&!z?H.$mount(function(e){x.append(e)}):x.append(k[0])),C&&b.length&&(b.children(".title-large").length&&b.addClass("navbar-inner-large"),n.$navbarEl.parents(doc).length||n.$el.prepend(n.$navbarEl),g.append(b[0]))),z?p.route&&p.route.route&&p.route.route.keepAlive&&!k[0].f7PageMounted&&(k[0].f7PageMounted=!0,n.pageCallback("mounted",k,b,I,E?I:"current",p,m)):n.pageCallback("mounted",k,b,I,E?I:"current",p,m),(p.reloadCurrent||M)&&m.length>0?n.params.stackPages&&n.initialPages.indexOf(m[0])>=0?(m.addClass("stacked"),m.trigger("page:stack"),n.emit("pageStack",m[0]),C&&y.addClass("stacked")):(n.pageCallback("beforeOut",m,y,"current",void 0,p),n.pageCallback("afterOut",m,y,"current",void 0,p),n.pageCallback("beforeRemove",m,y,"current",void 0,p),n.removePage(m),C&&y&&y.length&&n.removeNavbar(y)):p.reloadAll?m.each(function(e,t){var a=$(t),r=$(o.navbar.getElByPage(a));n.params.stackPages&&n.initialPages.indexOf(a[0])>=0?(a.addClass("stacked"),a.trigger("page:stack"),n.emit("pageStack",a[0]),C&&r.addClass("stacked")):(a.hasClass("page-current")&&(n.pageCallback("beforeOut",m,y,"current",void 0,p),n.pageCallback("afterOut",m,y,"current",void 0,p)),n.pageCallback("beforeRemove",a,y&&y.eq(e),"previous",void 0,p),n.removePage(a),C&&r.length&&n.removeNavbar(r))}):p.reloadPrevious&&(n.params.stackPages&&n.initialPages.indexOf(m[0])>=0?(m.addClass("stacked"),m.trigger("page:stack"),n.emit("pageStack",m[0]),C&&y.addClass("stacked")):(n.pageCallback("beforeRemove",m,y,"previous",void 0,p),n.removePage(m),C&&y&&y.length&&n.removeNavbar(y))),p.route.route.tab&&n.tabLoad(p.route.route.tab,Utils.extend({},p,{history:!1,pushState:!1})),n.pageCallback("init",k,b,I,E?I:"current",p,m),p.reloadCurrent||p.reloadAll||M)return n.allowPageChange=!0,n.pageCallback("beforeIn",k,b,I,"current",p),k.removeAttr("aria-hidden"),w&&b&&b.removeAttr("aria-hidden"),n.pageCallback("afterIn",k,b,I,"current",p),p.reloadCurrent&&p.clearPreviousHistory&&n.clearPreviousHistory(),M&&(a.classList.add("page-previous"),a.classList.remove("page-current"),$(a).trigger("page:position",{position:"previous"}),n.emit("pagePosition",a,"previous"),a.f7Page&&a.f7Page.navbarEl&&(a.f7Page.navbarEl.classList.add("navbar-previous"),a.f7Page.navbarEl.classList.remove("navbar-current"))),n;if(p.reloadPrevious)return n.allowPageChange=!0,n;function U(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";k.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),n.emit("pagePosition",k[0],"current"),m.removeClass(e).addClass("page-previous").trigger("page:position",{position:"previous"}),n.emit("pagePosition",m[0],"previous"),m.hasClass("page-master")||m.attr("aria-hidden","true"),w&&(b.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),y.removeClass(t).addClass("navbar-previous"),y.hasClass("navbar-master")||y.attr("aria-hidden","true")),n.allowPageChange=!0,n.pageCallback("afterOut",m,y,"current","previous",p),n.pageCallback("afterIn",k,b,"next","current",p);var a=(n.params.preloadPreviousPage||n.params[o.theme+"SwipeBack"])&&!d;a||(k.hasClass("smart-select-page")||k.hasClass("photo-browser-page")||k.hasClass("autocomplete-page")||k.hasClass("color-picker-page"))&&(a=!0),a||(n.params.stackPages?(m.addClass("stacked"),m.trigger("page:stack"),n.emit("pageStack",m[0]),C&&y.addClass("stacked")):k.attr("data-name")&&"smart-select-page"===k.attr("data-name")||(n.pageCallback("beforeRemove",m,y,"previous",void 0,p),n.removePage(m),C&&y.length&&n.removeNavbar(y))),p.clearPreviousHistory&&n.clearPreviousHistory(),n.emit("routeChanged",n.currentRoute,n.previousRoute,n),n.params.pushState&&History.clearRouterQueue()}function N(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";m.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),n.emit("pagePosition",m[0],"current"),k.removeClass(e).addClass("page-next").removeAttr("aria-hidden").trigger("page:position",{position:"next"}),n.emit("pagePosition",k[0],"next"),w&&(y.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),b.removeClass(t).addClass("navbar-next").removeAttr("aria-hidden"))}if(n.pageCallback("beforeOut",m,y,"current","previous",p),n.pageCallback("beforeIn",k,b,"next","current",p),!p.animate||d&&o.width>=n.params.masterDetailBreakpoint)U();else{var V=n.params[n.app.theme+"PageLoadDelay"];V?setTimeout(function(){N(),n.animate(m,k,y,b,"forward",function(){U()})},V):(N(),n.animate(m,k,y,b,"forward",function(){U()}))}return n}function load(e,t,a){void 0===e&&(e={}),void 0===t&&(t={});var r=this;if(!r.allowPageChange&&!a)return r;var i=e,n=t,s=i.url,o=i.content,l=i.el,p=i.pageName,c=i.template,d=i.templateUrl,u=i.component,h=i.componentUrl;if(!n.reloadCurrent&&n.route&&n.route.route&&n.route.route.parentPath&&r.currentRoute.route&&r.currentRoute.route.parentPath===n.route.route.parentPath){if(n.route.url===r.url)return r.allowPageChange=!0,!1;var f=Object.keys(n.route.params).length===Object.keys(r.currentRoute.params).length;if(f&&Object.keys(n.route.params).forEach(function(e){e in r.currentRoute.params&&r.currentRoute.params[e]===n.route.params[e]||(f=!1)}),f)return!!n.route.route.tab&&r.tabLoad(n.route.route.tab,n);if(!f&&n.route.route.tab&&r.currentRoute.route.tab&&r.currentRoute.parentPath===n.route.parentPath)return r.tabLoad(n.route.route.tab,n)}if(n.route&&n.route.url&&r.url===n.route.url&&!n.reloadCurrent&&!n.reloadPrevious&&!r.params.allowDuplicateUrls)return r.allowPageChange=!0,!1;function v(e,t){return r.forward(e,Utils.extend(n,t))}function m(){return r.allowPageChange=!0,r}if(!n.route&&s&&(n.route=r.parseRouteUrl(s),Utils.extend(n.route,{route:{url:s,path:s}})),(s||d||h)&&(r.allowPageChange=!1),o)r.forward(r.getPageEl(o),n);else if(c||d)try{r.pageTemplateLoader(c,d,n,v,m)}catch(e){throw r.allowPageChange=!0,e}else if(l)r.forward(r.getPageEl(l),n);else if(p)r.forward(r.$el.children('.page[data-name="'+p+'"]').eq(0),n);else if(u||h)try{r.pageComponentLoader(r.el,u,h,n,v,m)}catch(e){throw r.allowPageChange=!0,e}else s&&(r.xhr&&(r.xhr.abort(),r.xhr=!1),r.xhrRequest(s,n).then(function(e){r.forward(r.getPageEl(e),n)}).catch(function(){r.allowPageChange=!0}));return r}function navigate(e,t){void 0===t&&(t={});var a,r,i,n,s,o,l=this;if(l.swipeBackActive)return l;if("string"==typeof e?a=e:(a=e.url,r=e.route,i=e.name,n=e.query,s=e.params),i){if(!(o=l.findRouteByKey("name",i)))throw new Error('Framework7: route with name "'+i+'" not found');if(a=l.constructRouteUrl(o,{params:s,query:n}))return l.navigate(a,t);throw new Error("Framework7: can't construct URL for route with name \""+i+'"')}var p=l.app;if(appRouterCheck(l,"navigate"),"#"===a||""===a)return l;var c=a.replace("./","");if("/"!==c[0]&&0!==c.indexOf("#")){var d=l.currentRoute.parentPath||l.currentRoute.path;c=((d?d+"/":"/")+c).replace("///","/").replace("//","/")}if(!(o=r?Utils.extend(l.parseRouteUrl(c),{route:Utils.extend({},r)}):l.findMatchingRoute(c)))return l;if(o.route.redirect)return redirect.call(l,"navigate",o,t);var u={};function h(){var e=!1;"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(t){o.route[t]&&!e&&(e=!0,l.modalLoad(t,o,u))}),o.route.keepAlive&&o.route.keepAliveData&&(l.load({el:o.route.keepAliveData.pageEl},u,!1),e=!0),"url content component pageName el componentUrl template templateUrl".split(" ").forEach(function(t){var a;o.route[t]&&!e&&(e=!0,l.load(((a={})[t]=o.route[t],a),u,!1))}),e||o.route.async&&(l.allowPageChange=!1,o.route.async.call(l,u.route,l.currentRoute,function(e,t){l.allowPageChange=!1;var a=!1;t&&t.context&&(o.context?o.context=Utils.extend({},o.context,t.context):o.context=t.context,u.route.context=o.context),"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(r){if(e[r]){a=!0;var i=Utils.extend({},o,{route:e});l.allowPageChange=!0,l.modalLoad(r,i,Utils.extend(u,t))}}),a||l.load(e,Utils.extend(u,t),!0)},function(){l.allowPageChange=!0}))}function f(){l.allowPageChange=!0}if(o.route.options?Utils.extend(u,o.route.options,t):Utils.extend(u,t),u.route=o,u&&u.context&&(o.context=u.context,u.route.context=u.context),l.params.masterDetailBreakpoint>0&&o.route.masterRoute){var v=!0,m=!1;if(l.currentRoute&&l.currentRoute.route&&(!l.currentRoute.route.master||l.currentRoute.route!==o.route.masterRoute&&l.currentRoute.route.path!==o.route.masterRoute.path||(v=!1),!l.currentRoute.route.masterRoute||l.currentRoute.route.masterRoute!==o.route.masterRoute&&l.currentRoute.route.masterRoute.path!==o.route.masterRoute.path||(v=!1,m=!0)),v||m&&t.reloadAll)return l.navigate(o.route.masterRoute.path,{animate:!1,reloadAll:t.reloadAll,reloadCurrent:t.reloadCurrent,reloadPrevious:t.reloadPrevious,pushState:!t.initial,history:!t.initial,once:{pageAfterIn:function(){l.navigate(e,Utils.extend({},t,{animate:!1,reloadAll:!1,reloadCurrent:!1,reloadPrevious:!1,history:!t.initial,pushState:!t.initial}))}}}),l}return processRouteQueue.call(l,o,l.currentRoute,function(){o.route.modules?p.loadModules(Array.isArray(o.route.modules)?o.route.modules:[o.route.modules]).then(function(){h()}).catch(function(){f()}):h()},function(){f()}),l}function tabLoad(e,t){void 0===t&&(t={});var a,r,i=this,n=Utils.extend({animate:i.params.animate,pushState:!0,history:!0,parentPageEl:null,preload:!1,on:{}},t);n.route&&(n.preload||n.route===i.currentRoute||(r=i.previousRoute,i.currentRoute=n.route),n.preload?(a=n.route,r=i.currentRoute):(a=i.currentRoute,r||(r=i.previousRoute)),i.params.pushState&&n.pushState&&!n.reloadPrevious&&History.replace(i.view.id,{url:n.route.url},(i.params.pushStateRoot||"")+i.params.pushStateSeparator+n.route.url),n.history&&(i.history[Math.max(i.history.length-1,0)]=n.route.url,i.saveHistory()));var s,o=$(n.parentPageEl||i.currentPageEl);s=o.length&&o.find("#"+e.id).length?o.find("#"+e.id).eq(0):i.view.selector?i.view.selector+" #"+e.id:"#"+e.id;var l,p=i.app.tab.show({tabEl:s,animate:n.animate,tabRoute:n.route}),c=p.$newTabEl,d=p.$oldTabEl,u=p.animated,h=p.onTabsChanged;if(c&&c.parents(".page").length>0&&n.route){var f=c.parents(".page")[0].f7Page;f&&n.route&&(f.route=n.route)}if(c[0].f7RouterTabLoaded)return d&&d.length?(u?h(function(){i.emit("routeChanged",i.currentRoute,i.previousRoute,i)}):i.emit("routeChanged",i.currentRoute,i.previousRoute,i),i):i;function v(t,a){var r=t.url,n=t.content,s=t.el,o=t.template,l=t.templateUrl,p=t.component,f=t.componentUrl;function v(t){i.allowPageChange=!0,t&&("string"==typeof t?c.html(t):(c.html(""),t.f7Component?t.f7Component.$mount(function(e){c.append(e)}):c.append(t)),c[0].f7RouterTabLoaded=!0,function(t){i.removeThemeElements(c);var a=c;"string"!=typeof t&&(a=$(t)),a.trigger("tab:init tab:mounted",e),i.emit("tabInit tabMounted",c[0],e),d&&d.length&&(u?h(function(){i.emit("routeChanged",i.currentRoute,i.previousRoute,i),i.params.unloadTabContent&&i.tabRemove(d,c,e)}):(i.emit("routeChanged",i.currentRoute,i.previousRoute,i),i.params.unloadTabContent&&i.tabRemove(d,c,e)))}(t))}function m(){return i.allowPageChange=!0,i}if(n)v(n);else if(o||l)try{i.tabTemplateLoader(o,l,a,v,m)}catch(e){throw i.allowPageChange=!0,e}else if(s)v(s);else if(p||f)try{i.tabComponentLoader(c[0],p,f,a,v,m)}catch(e){throw i.allowPageChange=!0,e}else r&&(i.xhr&&(i.xhr.abort(),i.xhr=!1),i.xhrRequest(r,a).then(function(e){v(e)}).catch(function(){i.allowPageChange=!0}))}return"url content component el componentUrl template templateUrl".split(" ").forEach(function(t){var a;e[t]&&(l=!0,v(((a={})[t]=e[t],a),n))}),e.async?e.async.call(i,a,r,function(e,t){v(e,Utils.extend(n,t))},function(){i.allowPageChange=!0}):l||(i.allowPageChange=!0),i}function tabRemove(e,t,a){var r;e[0]&&(e[0].f7RouterTabLoaded=!1,delete e[0].f7RouterTabLoaded),e.children().each(function(e,t){t.f7Component&&(r=!0,$(t).trigger("tab:beforeremove",a),t.f7Component.$destroy())}),r||e.trigger("tab:beforeremove",a),this.emit("tabBeforeRemove",e[0],t[0],a),this.removeTabContent(e[0],a)}function modalLoad(e,t,a){void 0===a&&(a={});var r,i=this,n=i.app,s="panel"===e,o=s?"panel":"modal",l=Utils.extend({animate:i.params.animate,pushState:!0,history:!0,on:{}},a),p=Utils.extend({},t.route[e]),c=t.route;function d(){var a=n[e].create(p);c.modalInstance=a;var r=a.el;function d(){a.close()}a.on(o+"Open",function(){r||(i.removeThemeElements(a.el),a.$el.trigger(e.toLowerCase()+":init "+e.toLowerCase()+":mounted",t,a),i.emit((s?"":"modalInit")+" "+e+"Init "+e+"Mounted",a.el,t,a)),i.once("swipeBackMove",d)}),a.on(o+"Close",function(){i.off("swipeBackMove",d),a.closeByRouter||i.back()}),a.on(o+"Closed",function(){a.$el.trigger(e.toLowerCase()+":beforeremove",t,a),a.emit((s?"":"modalBeforeRemove ")+e+"BeforeRemove",a.el,t,a);var r=a.el.f7Component;r&&r.$destroy(),Utils.nextTick(function(){(r||p.component)&&i.removeModal(a.el),a.destroy(),delete a.route,delete c.modalInstance})}),l.route&&(i.params.pushState&&l.pushState&&History.push(i.view.id,{url:l.route.url,modal:e},(i.params.pushStateRoot||"")+i.params.pushStateSeparator+l.route.url),l.route!==i.currentRoute&&(a.route=Utils.extend(l.route,{modal:a}),i.currentRoute=a.route),l.history&&(i.history.push(l.route.url),i.saveHistory())),r&&(i.removeThemeElements(a.el),a.$el.trigger(e.toLowerCase()+":init "+e.toLowerCase()+":mounted",t,a),i.emit(o+"Init "+e+"Init "+e+"Mounted",a.el,t,a)),a.open()}function u(e,t){var a=e.url,r=e.content,s=e.template,o=e.templateUrl,l=e.component,c=e.componentUrl;function u(e){e&&("string"==typeof e?p.content=e:e.f7Component?e.f7Component.$mount(function(e){p.el=e,n.root.append(e)}):p.el=e,d())}function h(){return i.allowPageChange=!0,i}if(r)u(r);else if(s||o)try{i.modalTemplateLoader(s,o,t,u,h)}catch(e){throw i.allowPageChange=!0,e}else if(l||c)try{i.modalComponentLoader(n.root[0],l,c,t,u,h)}catch(e){throw i.allowPageChange=!0,e}else a?(i.xhr&&(i.xhr.abort(),i.xhr=!1),i.xhrRequest(a,t).then(function(e){p.content=e,d()}).catch(function(){i.allowPageChange=!0})):d()}return"url content component el componentUrl template templateUrl".split(" ").forEach(function(e){var t;p[e]&&!r&&(r=!0,u(((t={})[e]=p[e],t),l))}),r||"actions"!==e||d(),p.async&&p.async.call(i,l.route,i.currentRoute,function(e,t){u(e,Utils.extend(l,t))},function(){i.allowPageChange=!0}),i}function modalRemove(e){Utils.extend(e,{closeByRouter:!0}),e.close()}function backward(e,t){var a,r,i,n,s,o,l=this,p=$(e),c=l.app,d=l.view,u=Utils.extend({animate:l.params.animate,pushState:!0,replaceState:!1},t),h=l.params.masterDetailBreakpoint>0,f=h&&u.route&&u.route.route&&!0===u.route.route.master,v=l.dynamicNavbar,m=l.separateNavbar,g=p,b=l.$el.children(".page-current"),y=h&&b.hasClass("page-master");if(g.length&&l.removeThemeElements(g),v&&(i=g.children(".navbar").children(".navbar-inner"),m?(r=l.$navbarEl,i.length>0&&g.children(".navbar").remove(),0===i.length&&g[0]&&g[0].f7Page&&(i=g[0].f7Page.$navbarEl),n=r.find(".navbar-current")):n=b.children(".navbar").children(".navbar-inner")),l.allowPageChange=!1,0===g.length||0===b.length)return l.allowPageChange=!0,l;if(l.removeThemeElements(g),u.route&&u.route.route&&u.route.route.keepAlive&&!u.route.route.keepAliveData&&(u.route.route.keepAliveData={pageEl:p[0]}),h){for(var w=l.$el.children(".page:not(.stacked)").filter(function(e,t){return t!==g[0]}),C=0;C<w.length;C+=1)a||!w[C].classList.contains("page-master")||(a=w[C]);!(s=!f&&a&&l.history.indexOf(u.route.url)>l.history.indexOf(a.f7Page.route.url))&&!f&&a&&a.f7Page&&u.route.route.masterRoute&&(s=u.route.route.masterRoute.path===a.f7Page.route.route.path)}if(g.addClass("page-previous"+(f?" page-master":"")+(s?" page-master-detail":"")).removeClass("stacked").removeAttr("aria-hidden").trigger("page:unstack").trigger("page:position",{position:"previous"}),l.emit("pageUnstack",g[0]),l.emit("pagePosition",g[0],"previous"),(f||s)&&g.trigger("page:role",{role:f?"master":"detail"}),v&&i.length>0&&i.addClass("navbar-previous"+(f?" navbar-master":"")+(s?" navbar-master-detail":"")).removeClass("stacked").removeAttr("aria-hidden"),u.force&&(b.prev(".page-previous:not(.stacked)").length>0||0===b.prev(".page-previous").length))if(l.history.indexOf(u.route.url)>=0?(o=l.history.length-l.history.indexOf(u.route.url)-1,l.history=l.history.slice(0,l.history.indexOf(u.route.url)+2),d.history=l.history):l.history[[l.history.length-2]]?l.history[l.history.length-2]=u.route.url:l.history.unshift(l.url),o&&l.params.stackPages)b.prevAll(".page-previous").each(function(e,t){var a,r=$(t);m&&(a=$(c.navbar.getElByPage(r))),r[0]!==g[0]&&r.index()>g.index()&&(l.initialPages.indexOf(r[0])>=0?(r.addClass("stacked"),r.trigger("page:stack"),l.emit("pageStack",r[0]),m&&a.addClass("stacked")):(l.pageCallback("beforeRemove",r,a,"previous",void 0,u),l.removePage(r),m&&a.length>0&&l.removeNavbar(a)))});else{var x,k=b.prev(".page-previous:not(.stacked)");m&&(x=$(c.navbar.getElByPage(k))),l.params.stackPages&&l.initialPages.indexOf(k[0])>=0?(k.addClass("stacked"),k.trigger("page:stack"),l.emit("pageStack",k[0]),x.addClass("stacked")):k.length>0&&(l.pageCallback("beforeRemove",k,x,"previous",void 0,u),l.removePage(k),m&&x.length&&l.removeNavbar(x))}var E,S,T=g.parents(doc).length>0,M=g[0].f7Component;function P(){0===g.next(b).length&&(!T&&M?M.$mount(function(e){$(e).insertBefore(b)}):g.insertBefore(b)),m&&i.length&&(i.children(".title-large").length&&i.addClass("navbar-inner-large"),i.insertBefore(n),n.length>0?i.insertBefore(n):(l.$navbarEl.parents(doc).length||l.$el.prepend(l.$navbarEl),r.append(i))),T?u.route&&u.route.route&&u.route.route.keepAlive&&!g[0].f7PageMounted&&(g[0].f7PageMounted=!0,l.pageCallback("mounted",g,i,"previous","current",u,b)):l.pageCallback("mounted",g,i,"previous","current",u,b)}if(u.preload){P(),u.route.route.tab&&l.tabLoad(u.route.route.tab,Utils.extend({},u,{history:!1,pushState:!1,preload:!0})),f&&(g.removeClass("page-master-stacked").trigger("page:masterunstack"),l.emit("pageMasterUnstack",g[0]),m&&$(c.navbar.getElByPage(g)).removeClass("navbar-master-stacked")),l.pageCallback("init",g,i,"previous","current",u,b);var O=g.prevAll(".page-previous:not(.stacked):not(.page-master)");return O.length>0&&O.each(function(e,t){var a,r=$(t);m&&(a=$(c.navbar.getElByPage(r))),l.params.stackPages&&l.initialPages.indexOf(t)>=0?(r.addClass("stacked"),r.trigger("page:stack"),l.emit("pageStack",r[0]),m&&a.addClass("stacked")):(l.pageCallback("beforeRemove",r,a,"previous",void 0),l.removePage(r),m&&a.length&&l.removeNavbar(a))}),l.allowPageChange=!0,l}if(!(Device.ie||Device.edge||Device.firefox&&!Device.ios)&&l.params.pushState&&u.pushState)if(u.replaceState){var D=l.params.pushStateRoot||"";History.replace(d.id,{url:u.route.url},D+l.params.pushStateSeparator+u.route.url)}else o?History.go(-o):History.back();if(u.replaceState?l.history[l.history.length-1]=u.route.url:(1===l.history.length&&l.history.unshift(l.url),l.history.pop()),l.saveHistory(),l.currentPageEl=g[0],v&&i.length?l.currentNavbarEl=i[0]:delete l.currentNavbarEl,l.currentRoute=u.route,(Device.ie||Device.edge||Device.firefox&&!Device.ios)&&l.params.pushState&&u.pushState)if(u.replaceState){var I=l.params.pushStateRoot||"";History.replace(d.id,{url:u.route.url},I+l.params.pushStateSeparator+u.route.url)}else o?History.go(-o):History.back();function R(){var e="page-previous page-current page-next",t="navbar-previous navbar-current navbar-next";g.removeClass(e).addClass("page-current").removeAttr("aria-hidden").trigger("page:position",{position:"current"}),l.emit("pagePosition",g[0],"current"),b.removeClass(e).addClass("page-next").attr("aria-hidden","true").trigger("page:position",{position:"next"}),l.emit("pagePosition",b[0],"next"),v&&(i.removeClass(t).addClass("navbar-current").removeAttr("aria-hidden"),n.removeClass(t).addClass("navbar-next").attr("aria-hidden","true")),l.pageCallback("afterOut",b,n,"current","next",u),l.pageCallback("afterIn",g,i,"previous","current",u),l.params.stackPages&&l.initialPages.indexOf(b[0])>=0?(b.addClass("stacked"),b.trigger("page:stack"),l.emit("pageStack",b[0]),m&&n.addClass("stacked")):(l.pageCallback("beforeRemove",b,n,"next",void 0,u),l.removePage(b),m&&n.length&&l.removeNavbar(n)),l.allowPageChange=!0,l.emit("routeChanged",l.currentRoute,l.previousRoute,l),(l.params.preloadPreviousPage||l.params[c.theme+"SwipeBack"])&&l.history[l.history.length-2]&&!f&&l.back(l.history[l.history.length-2],{preload:!0}),l.params.pushState&&History.clearRouterQueue()}return P(),u.route.route.tab&&l.tabLoad(u.route.route.tab,Utils.extend({},u,{history:!1,pushState:!1})),l.pageCallback("init",g,i,"previous","current",u,b),l.pageCallback("beforeOut",b,n,"current","next",u),l.pageCallback("beforeIn",g,i,"previous","current",u),!u.animate||y&&c.width>=l.params.masterDetailBreakpoint?R():(E="page-previous page-current page-next",S="navbar-previous navbar-current navbar-next",b.removeClass(E).addClass("page-current").trigger("page:position",{position:"current"}),l.emit("pagePosition",b[0],"current"),g.removeClass(E).addClass("page-previous").removeAttr("aria-hidden").trigger("page:position",{position:"previous"}),l.emit("pagePosition",g[0],"previous"),v&&(n.removeClass(S).addClass("navbar-current"),i.removeClass(S).addClass("navbar-previous").removeAttr("aria-hidden")),l.animate(b,g,n,i,"backward",function(){R()})),l}function loadBack(e,t,a){var r=this;if(!r.allowPageChange&&!a)return r;var i=e,n=t,s=i.url,o=i.content,l=i.el,p=i.pageName,c=i.template,d=i.templateUrl,u=i.component,h=i.componentUrl;if(n.route.url&&r.url===n.route.url&&!n.reloadCurrent&&!n.reloadPrevious&&!r.params.allowDuplicateUrls)return!1;function f(e,t){return r.backward(e,Utils.extend(n,t))}function v(){return r.allowPageChange=!0,r}if(!n.route&&s&&(n.route=r.parseRouteUrl(s)),(s||d||h)&&(r.allowPageChange=!1),o)r.backward(r.getPageEl(o),n);else if(c||d)try{r.pageTemplateLoader(c,d,n,f,v)}catch(e){throw r.allowPageChange=!0,e}else if(l)r.backward(r.getPageEl(l),n);else if(p)r.backward(r.$el.children('.page[data-name="'+p+'"]').eq(0),n);else if(u||h)try{r.pageComponentLoader(r.el,u,h,n,f,v)}catch(e){throw r.allowPageChange=!0,e}else s&&(r.xhr&&(r.xhr.abort(),r.xhr=!1),r.xhrRequest(s,n).then(function(e){r.backward(r.getPageEl(e),n)}).catch(function(){r.allowPageChange=!0}));return r}function back(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];var a,r,i,n=this;if(n.swipeBackActive)return n;"object"==typeof e[0]?r=e[0]||{}:(a=e[0],r=e[1]||{});var s=r.name,o=r.params,l=r.query;if(s){if(!(i=n.findRouteByKey("name",s)))throw new Error('Framework7: route with name "'+s+'" not found');if(a=n.constructRouteUrl(i,{params:o,query:l}))return n.back(a,Utils.extend({},r,{name:null,params:null,query:null}));throw new Error("Framework7: can't construct URL for route with name \""+s+'"')}var p=n.app;appRouterCheck(n,"back");var c,d=n.currentRoute.modal;if(d||"popup popover sheet loginScreen actions customModal panel".split(" ").forEach(function(e){n.currentRoute.route[e]&&(d=!0,c=e)}),d){var u,h=n.currentRoute.modal||n.currentRoute.route.modalInstance||p[c].get(),f=n.history[n.history.length-2];if(h&&h.$el){var v=h.$el.prevAll(".modal-in");v.length&&v[0].f7Modal&&(u=v[0].f7Modal.route)}if(u||(u=n.findMatchingRoute(f)),!u&&f&&(u={url:f,path:f.split("?")[0],query:Utils.parseUrlQuery(f),route:{path:f.split("?")[0],url:f}}),!(a&&0!==a.replace(/[# ]/g,"").trim().length||u&&h))return n;var m=r.force&&u&&a;if(u&&h){var g=Device.ie||Device.edge||Device.firefox&&!Device.ios,b=n.params.pushState&&!1!==r.pushState;b&&!g&&History.back(),n.currentRoute=u,n.history.pop(),n.saveHistory(),b&&g&&History.back(),n.modalRemove(h),m&&n.navigate(a,{reloadCurrent:!0})}else h&&(n.modalRemove(h),a&&n.navigate(a,{reloadCurrent:!0}));return n}var y,w=n.$el.children(".page-current").prevAll(".page-previous:not(.page-master)").eq(0);if(n.params.masterDetailBreakpoint>0){var C=n.$el.children(".page-current").prevAll(".page-master").eq(0);if(C.length){var x=n.history[n.history.length-2],$=n.findMatchingRoute(x);$&&$.route===C[0].f7Page.route.route&&(w=C,r.preload||(y=p.width>=n.params.masterDetailBreakpoint))}}if(!r.force&&w.length&&!y){if(n.params.pushState&&w[0].f7Page&&n.history[n.history.length-2]!==w[0].f7Page.route.url)return n.back(n.history[n.history.length-2],Utils.extend(r,{force:!0})),n;var k=w[0].f7Page.route;return processRouteQueue.call(n,k,n.currentRoute,function(){n.loadBack({el:w},Utils.extend(r,{route:k}))},function(){}),n}if("#"===a&&(a=void 0),a&&"/"!==a[0]&&0!==a.indexOf("#")&&(a=((n.path||"/")+a).replace("//","/")),!a&&n.history.length>1&&(a=n.history[n.history.length-2]),y&&!r.force&&n.history[n.history.length-3])return n.back(n.history[n.history.length-3],Utils.extend({},r||{},{force:!0,animate:!1}));if(y&&!r.force)return n;if((i=n.findMatchingRoute(a))||a&&(i={url:a,path:a.split("?")[0],query:Utils.parseUrlQuery(a),route:{path:a.split("?")[0],url:a}}),!i)return n;if(i.route.redirect)return redirect.call(n,"back",i,r);var E,S={};if(i.route.options?Utils.extend(S,i.route.options,r):Utils.extend(S,r),S.route=i,S&&S.context&&(i.context=S.context,S.route.context=S.context),S.force&&n.params.stackPages&&(n.$el.children(".page-previous.stacked").each(function(e,t){t.f7Page&&t.f7Page.route&&t.f7Page.route.url===i.url&&(E=!0,n.loadBack({el:t},S))}),E))return n;function T(){var e=!1;i.route.keepAlive&&i.route.keepAliveData&&(n.loadBack({el:i.route.keepAliveData.pageEl},S),e=!0),"url content component pageName el componentUrl template templateUrl".split(" ").forEach(function(t){var a;i.route[t]&&!e&&(e=!0,n.loadBack(((a={})[t]=i.route[t],a),S))}),e||i.route.async&&(n.allowPageChange=!1,i.route.async.call(n,i,n.currentRoute,function(e,t){n.allowPageChange=!1,t&&t.context&&(i.context?i.context=Utils.extend({},i.context,t.context):i.context=t.context,S.route.context=i.context),n.loadBack(e,Utils.extend(S,t),!0)},function(){n.allowPageChange=!0}))}function M(){n.allowPageChange=!0}return S.preload?T():processRouteQueue.call(n,i,n.currentRoute,function(){i.route.modules?p.loadModules(Array.isArray(i.route.modules)?i.route.modules:[i.route.modules]).then(function(){T()}).catch(function(){M()}):T()},function(){M()}),n}function clearPreviousPages(){var e=this;appRouterCheck(e,"clearPreviousPages");var t=e.app,a=e.separateNavbar;e.$el.children(".page").filter(function(t,a){return!(!e.currentRoute||!e.currentRoute.modal&&!e.currentRoute.panel)||a!==e.currentPageEl}).each(function(r,i){var n=$(i),s=$(t.navbar.getElByPage(n));e.params.stackPages&&e.initialPages.indexOf(n[0])>=0?(n.addClass("stacked"),a&&s.addClass("stacked")):(e.pageCallback("beforeRemove",n,s,"previous",void 0,{}),e.removePage(n),a&&s.length&&e.removeNavbar(s))})}function clearPreviousHistory(){appRouterCheck(this,"clearPreviousHistory");var e=this.history[this.history.length-1];this.clearPreviousPages(),this.history=[e],this.view.history=[e],this.saveHistory()}var Router=function(e){function t(t,a){e.call(this,{},[void 0===a?t:a]);var r=this;r.isAppRouter=void 0===a,r.isAppRouter?Utils.extend(!1,r,{app:t,params:t.params.view,routes:t.routes||[],cache:t.cache}):Utils.extend(!1,r,{app:t,view:a,viewId:a.id,params:a.params,routes:a.routes,$el:a.$el,el:a.el,$navbarEl:a.$navbarEl,navbarEl:a.navbarEl,history:a.history,scrollHistory:a.scrollHistory,cache:t.cache,dynamicNavbar:"ios"===t.theme&&a.params.iosDynamicNavbar,separateNavbar:"ios"===t.theme&&a.params.iosDynamicNavbar&&a.params.iosSeparateDynamicNavbar,initialPages:[],initialNavbars:[]}),r.useModules(),r.tempDom=doc.createElement("div"),r.allowPageChange=!0;var i={},n={};return Object.defineProperty(r,"currentRoute",{enumerable:!0,configurable:!0,set:function(e){void 0===e&&(e={}),n=Utils.extend({},i),(i=e)&&(r.url=i.url,r.emit("routeChange",e,n,r))},get:function(){return i}}),Object.defineProperty(r,"previousRoute",{enumerable:!0,configurable:!0,get:function(){return n},set:function(e){n=e}}),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.animatableNavElements=function(e,t,a,r,i){var n,s,o=this.dynamicNavbar,l=this.separateNavbar,p=this.params.iosAnimateNavbarBackIcon;function c(e,t){var a,r=e.hasClass("sliding")||t.hasClass("sliding"),i=e.hasClass("subnavbar"),n=!r||!i,s=e.find(".back .icon");return r&&p&&e.hasClass("left")&&s.length>0&&s.next("span").length&&(e=s.next("span"),a=!0),{$el:e,isIconLabel:a,leftOffset:e[0].f7NavbarLeftOffset,rightOffset:e[0].f7NavbarRightOffset,isSliding:r,isSubnavbar:i,needsOpacityTransition:n}}return o&&(n=[],s=[],e.children(".left, .right, .title, .subnavbar").each(function(t,s){var o=$(s);o.hasClass("left")&&r&&"forward"===i&&l||o.hasClass("title")&&a||n.push(c(o,e))}),t.hasClass("navbar-master")&&this.params.masterDetailBreakpoint>0&&this.app.width>=this.params.masterDetailBreakpoint||t.children(".left, .right, .title, .subnavbar").each(function(e,n){var o=$(n);o.hasClass("left")&&a&&!r&&"forward"===i&&l||o.hasClass("left")&&a&&"backward"===i&&l||o.hasClass("title")&&r||s.push(c(o,t))}),[s,n].forEach(function(e){e.forEach(function(t){var a=t,r=t.isSliding,i=t.$el,o=e===s?n:s;r&&i.hasClass("title")&&o&&o.forEach(function(e){if(e.isIconLabel){var t=e.$el[0];a.leftOffset+=t&&t.offsetLeft||0}})})})),{newNavEls:n,oldNavEls:s}},t.prototype.animate=function(e,t,a,r,i,n){var s=this;if(s.params.animateCustom)s.params.animateCustom.apply(s,[e,t,a,r,i,n]);else{var o,l,p,c,d,u,h=s.dynamicNavbar,f="ios"===s.app.theme,v="router-transition-"+i+" router-transition";if(f&&h){d=a&&a.hasClass("navbar-inner-large"),u=r&&r.hasClass("navbar-inner-large"),p=d&&!a.hasClass("navbar-inner-large-collapsed"),c=u&&!r.hasClass("navbar-inner-large-collapsed");var m=s.animatableNavElements(r,a,c,p,i);o=m.newNavEls,l=m.oldNavEls}("forward"===i?t:e).animationEnd(function(){s.dynamicNavbar&&(r&&(r.removeClass("router-navbar-transition-to-large router-navbar-transition-from-large"),r.addClass("navbar-no-title-large-transition"),Utils.nextFrame(function(){r.removeClass("navbar-no-title-large-transition")})),a&&a.removeClass("router-navbar-transition-to-large router-navbar-transition-from-large"),r.hasClass("sliding")?r.find(".title, .left, .right, .left .icon, .subnavbar").transform(""):r.find(".sliding").transform(""),a.hasClass("sliding")?a.find(".title, .left, .right, .left .icon, .subnavbar").transform(""):a.find(".sliding").transform("")),s.$el.removeClass(v),n&&n()}),h?(g(0),Utils.nextFrame(function(){g(1),s.$el.addClass(v)})):s.$el.addClass(v)}function g(e){f&&h&&(1===e&&(c&&(r.addClass("router-navbar-transition-to-large"),a.addClass("router-navbar-transition-to-large")),p&&(r.addClass("router-navbar-transition-from-large"),a.addClass("router-navbar-transition-from-large"))),o.forEach(function(t){var a=t.$el,r="forward"===i?t.rightOffset:t.leftOffset;t.isSliding&&(t.isSubnavbar&&u?a[0].style.setProperty("transform","translate3d("+r*(1-e)+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)","important"):a.transform("translate3d("+r*(1-e)+"px,0,0)"))}),l.forEach(function(t){var a=t.$el,r="forward"===i?t.leftOffset:t.rightOffset;t.isSliding&&(t.isSubnavbar&&d?a.transform("translate3d("+r*e+"px, calc(-1 * var(--f7-navbar-large-collapse-progress) * var(--f7-navbar-large-title-height)), 0)"):a.transform("translate3d("+r*e+"px,0,0)"))}))}},t.prototype.removeModal=function(e){this.removeEl(e)},t.prototype.removeTabContent=function(e){$(e).html("")},t.prototype.removeNavbar=function(e){this.removeEl(e)},t.prototype.removePage=function(e){var t=$(e),a=t&&t[0]&&t[0].f7Page;a&&a.route&&a.route.route&&a.route.route.keepAlive?t.remove():this.removeEl(e)},t.prototype.removeEl=function(e){if(e){var t=$(e);0!==t.length&&(t.find(".tab").each(function(e,t){$(t).children().each(function(e,t){t.f7Component&&($(t).trigger("tab:beforeremove"),t.f7Component.$destroy())})}),t[0].f7Component&&t[0].f7Component.$destroy&&t[0].f7Component.$destroy(),this.params.removeElements&&(this.params.removeElementsWithTimeout?setTimeout(function(){t.remove()},this.params.removeElementsTimeout):t.remove()))}},t.prototype.getPageEl=function(e){if("string"==typeof e)this.tempDom.innerHTML=e;else{if($(e).hasClass("page"))return e;this.tempDom.innerHTML="",$(this.tempDom).append(e)}return this.findElement(".page",this.tempDom)},t.prototype.findElement=function(e,t,a){var r=this.view,i=this.app,n=$(t),s=e;a&&(s+=":not(.stacked)");var o=n.find(s).filter(function(e,t){return 0===$(t).parents(".popup, .dialog, .popover, .actions-modal, .sheet-modal, .login-screen, .page").length});return o.length>1&&("string"==typeof r.selector&&(o=n.find(r.selector+" "+s)),o.length>1&&(o=n.find("."+i.params.viewMainClass+" "+s))),1===o.length?o:(a||(o=this.findElement(s,n,!0)),o&&1===o.length?o:o&&o.length>1?$(o[0]):void 0)},t.prototype.flattenRoutes=function(e){void 0===e&&(e=this.routes);var t=this,a=[];return e.forEach(function(e){var r=!1;if("tabs"in e&&e.tabs){var i=e.tabs.map(function(t){var a=Utils.extend({},e,{path:(e.path+"/"+t.path).replace("///","/").replace("//","/"),parentPath:e.path,tab:t});return delete a.tabs,delete a.routes,a});r=!0,a=a.concat(t.flattenRoutes(i))}if("detailRoutes"in e){var n=e.detailRoutes.map(function(t){var a=Utils.extend({},t);return a.masterRoute=e,a.masterRoutePath=e.path,a});a=a.concat(e,t.flattenRoutes(n))}if("routes"in e){var s=e.routes.map(function(t){var a=Utils.extend({},t);return a.path=(e.path+"/"+a.path).replace("///","/").replace("//","/"),a});a=r?a.concat(t.flattenRoutes(s)):a.concat(e,t.flattenRoutes(s))}"routes"in e||"tabs"in e&&e.tabs||"detailRoutes"in e||a.push(e)}),a},t.prototype.parseRouteUrl=function(e){if(!e)return{};var t=Utils.parseUrlQuery(e),a=e.split("#")[1],r=e.split("#")[0].split("?")[0];return{query:t,hash:a,params:{},url:e,path:r}},t.prototype.constructRouteUrl=function(e,t){void 0===t&&(t={});var a,r=t.params,i=t.query,n=e.path,s=pathToRegexp_1.compile(n);try{a=s(r||{})}catch(e){throw new Error("Framework7: error constructing route URL from passed params:\nRoute: "+n+"\n"+e.toString())}return i&&(a+="string"==typeof i?"?"+i:"?"+Utils.serializeObject(i)),a},t.prototype.findTabRoute=function(e){var t,a=$(e),r=this.currentRoute.route.parentPath,i=a.attr("id");return this.flattenRoutes(this.routes).forEach(function(e){e.parentPath===r&&e.tab&&e.tab.id===i&&(t=e)}),t},t.prototype.findRouteByKey=function(e,t){var a,r=this.routes;return this.flattenRoutes(r).forEach(function(r){a||r[e]===t&&(a=r)}),a},t.prototype.findMatchingRoute=function(e){if(e){var t,a=this.routes,r=this.flattenRoutes(a),i=this.parseRouteUrl(e),n=i.path,s=i.query,o=i.hash,l=i.params;return r.forEach(function(a){if(!t){var r,i,p=[],c=[a.path];if(a.alias&&("string"==typeof a.alias?c.push(a.alias):Array.isArray(a.alias)&&a.alias.forEach(function(e){c.push(e)})),c.forEach(function(e){r||(r=pathToRegexp_1(e,p).exec(n))}),r)p.forEach(function(e,t){if("number"!=typeof e.name){var a=r[t+1];l[e.name]=null==a?a:decodeURIComponent(a)}}),a.parentPath&&(i=n.split("/").slice(0,a.parentPath.split("/").length-1).join("/")),t={query:s,hash:o,params:l,url:e,path:n,parentPath:i,route:a,name:a.name}}}),t}},t.prototype.replaceRequestUrlParams=function(e,t){void 0===e&&(e=""),void 0===t&&(t={});var a=e;return"string"==typeof a&&a.indexOf("{{")>=0&&t&&t.route&&t.route.params&&Object.keys(t.route.params).length&&Object.keys(t.route.params).forEach(function(e){var r=new RegExp("{{"+e+"}}","g");a=a.replace(r,t.route.params[e]||"")}),a},t.prototype.removeFromXhrCache=function(e){for(var t=this.cache.xhr,a=!1,r=0;r<t.length;r+=1)t[r].url===e&&(a=r);!1!==a&&t.splice(a,1)},t.prototype.xhrRequest=function(e,t){var a=this,r=a.params,i=t.ignoreCache,n=e,s=n.indexOf("?")>=0;return r.passRouteQueryToRequest&&t&&t.route&&t.route.query&&Object.keys(t.route.query).length&&(n+=(s?"&":"?")+Utils.serializeObject(t.route.query),s=!0),r.passRouteParamsToRequest&&t&&t.route&&t.route.params&&Object.keys(t.route.params).length&&(n+=(s?"&":"?")+Utils.serializeObject(t.route.params),s=!0),n.indexOf("{{")>=0&&(n=a.replaceRequestUrlParams(n,t)),r.xhrCacheIgnoreGetParameters&&n.indexOf("?")>=0&&(n=n.split("?")[0]),new Promise(function(e,s){if(r.xhrCache&&!i&&n.indexOf("nocache")<0&&r.xhrCacheIgnore.indexOf(n)<0)for(var o=0;o<a.cache.xhr.length;o+=1){var l=a.cache.xhr[o];if(l.url===n&&Utils.now()-l.time<r.xhrCacheDuration)return void e(l.content)}a.xhr=a.app.request({url:n,method:"GET",beforeSend:function(e){a.emit("routerAjaxStart",e,t)},complete:function(i,o){a.emit("routerAjaxComplete",i),"error"!==o&&"timeout"!==o&&i.status>=200&&i.status<300||0===i.status?(r.xhrCache&&""!==i.responseText&&(a.removeFromXhrCache(n),a.cache.xhr.push({url:n,time:Utils.now(),content:i.responseText})),a.emit("routerAjaxSuccess",i,t),e(i.responseText)):(a.emit("routerAjaxError",i,t),s(i))},error:function(e){a.emit("routerAjaxError",e,t),s(e)}})})},t.prototype.removeThemeElements=function(e){var t,a=this.app.theme;"ios"===a?t=".md-only, .aurora-only, .if-md, .if-aurora, .if-not-ios, .not-ios":"md"===a?t=".ios-only, .aurora-only, .if-ios, .if-aurora, .if-not-md, .not-md":"aurora"===a&&(t=".ios-only, .md-only, .if-ios, .if-md, .if-not-aurora, .not-aurora"),$(e).find(t).remove()},t.prototype.getPageData=function(e,t,a,r,i,n){void 0===i&&(i={});var s,o,l=$(e).eq(0),p=$(t).eq(0),c=l[0].f7Page||{};if(("next"===a&&"current"===r||"current"===a&&"previous"===r)&&(s="forward"),("current"===a&&"next"===r||"previous"===a&&"current"===r)&&(s="backward"),c&&!c.fromPage){var d=$(n);d.length&&(o=d[0].f7Page)}(o=c.pageFrom||o)&&o.pageFrom&&(o.pageFrom=null);var u={app:this.app,view:this.view,router:this,$el:l,el:l[0],$pageEl:l,pageEl:l[0],$navbarEl:p,navbarEl:p[0],name:l.attr("data-name"),position:a,from:a,to:r,direction:s,route:c.route?c.route:i,pageFrom:o};return l[0].f7Page=u,u},t.prototype.pageCallback=function(e,t,a,r,i,n,s){if(void 0===n&&(n={}),t){var o=this,l=$(t);if(l.length){var p=$(a),c=n.route,d=o.params.restoreScrollTopOnBack&&!(o.params.masterDetailBreakpoint>0&&l.hasClass("page-master")&&o.app.width>=o.params.masterDetailBreakpoint),u=l[0].f7Page&&l[0].f7Page.route&&l[0].f7Page.route.route&&l[0].f7Page.route.route.keepAlive;"beforeRemove"===e&&u&&(e="beforeUnmount");var h="page"+(e[0].toUpperCase()+e.slice(1,e.length)),f="page:"+e.toLowerCase(),v={};(v="beforeRemove"===e&&l[0].f7Page?Utils.extend(l[0].f7Page,{from:r,to:i,position:r}):o.getPageData(l[0],p[0],r,i,c,s)).swipeBack=!!n.swipeBack;var m=n.route?n.route.route:{},g=m.on;void 0===g&&(g={});var b=m.once;if(void 0===b&&(b={}),n.on&&Utils.extend(g,n.on),n.once&&Utils.extend(b,n.once),"mounted"===e&&C(),"init"===e){if(d&&("previous"===r||!r)&&"current"===i&&o.scrollHistory[v.route.url]&&!l.hasClass("no-restore-scroll")){var y=l.find(".page-content");y.length>0&&(y=y.filter(function(e,t){return 0===$(t).parents(".tab:not(.tab-active)").length&&!$(t).is(".tab:not(.tab-active)")})),y.scrollTop(o.scrollHistory[v.route.url])}if(C(),l[0].f7PageInitialized)return l.trigger("page:reinit",v),void o.emit("pageReinit",v);l[0].f7PageInitialized=!0}if(d&&"beforeOut"===e&&"current"===r&&"previous"===i){var w=l.find(".page-content");w.length>0&&(w=w.filter(function(e,t){return 0===$(t).parents(".tab:not(.tab-active)").length&&!$(t).is(".tab:not(.tab-active)")})),o.scrollHistory[v.route.url]=w.scrollTop()}d&&"beforeOut"===e&&"current"===r&&"next"===i&&delete o.scrollHistory[v.route.url],l.trigger(f,v),o.emit(h,v),"beforeRemove"!==e&&"beforeUnmount"!==e||(l[0].f7RouteEventsAttached&&(l[0].f7RouteEventsOn&&Object.keys(l[0].f7RouteEventsOn).forEach(function(e){l.off(Utils.eventNameToColonCase(e),l[0].f7RouteEventsOn[e])}),l[0].f7RouteEventsOnce&&Object.keys(l[0].f7RouteEventsOnce).forEach(function(e){l.off(Utils.eventNameToColonCase(e),l[0].f7RouteEventsOnce[e])}),l[0].f7RouteEventsAttached=null,l[0].f7RouteEventsOn=null,l[0].f7RouteEventsOnce=null,delete l[0].f7RouteEventsAttached,delete l[0].f7RouteEventsOn,delete l[0].f7RouteEventsOnce),u||(l[0].f7Page&&l[0].f7Page.navbarEl&&delete l[0].f7Page.navbarEl.f7Page,l[0].f7Page=null))}}function C(){l[0].f7RouteEventsAttached||(l[0].f7RouteEventsAttached=!0,g&&Object.keys(g).length>0&&(l[0].f7RouteEventsOn=g,Object.keys(g).forEach(function(e){g[e]=g[e].bind(o),l.on(Utils.eventNameToColonCase(e),g[e])})),b&&Object.keys(b).length>0&&(l[0].f7RouteEventsOnce=b,Object.keys(b).forEach(function(e){b[e]=b[e].bind(o),l.once(Utils.eventNameToColonCase(e),b[e])})))}},t.prototype.saveHistory=function(){this.view.history=this.history,this.params.pushState&&(win.localStorage["f7router-"+this.view.id+"-history"]=JSON.stringify(this.history))},t.prototype.restoreHistory=function(){this.params.pushState&&win.localStorage["f7router-"+this.view.id+"-history"]&&(this.history=JSON.parse(win.localStorage["f7router-"+this.view.id+"-history"]),this.view.history=this.history)},t.prototype.clearHistory=function(){this.history=[],this.view&&(this.view.history=[]),this.saveHistory()},t.prototype.updateCurrentUrl=function(e){appRouterCheck(this,"updateCurrentUrl"),this.history.length?this.history[this.history.length-1]=e:this.history.push(e);var t=this.parseRouteUrl(e),a=t.query,r=t.hash,i=t.params,n=t.url,s=t.path;if(this.currentRoute&&Utils.extend(this.currentRoute,{query:a,hash:r,params:i,url:n,path:s}),this.params.pushState){var o=this.params.pushStateRoot||"";History.replace(this.view.id,{url:e},o+this.params.pushStateSeparator+e)}this.saveHistory(),this.emit("routeUrlUpdate",this.currentRoute,this)},t.prototype.init=function(){var e=this,t=e.app,a=e.view;(a&&e.params.iosSwipeBack&&"ios"===t.theme||a&&e.params.mdSwipeBack&&"md"===t.theme||a&&e.params.auroraSwipeBack&&"aurora"===t.theme)&&SwipeBack(e),e.dynamicNavbar&&!e.separateNavbar&&e.$el.addClass("router-dynamic-navbar-inside");var r,i,n,s=e.params.url,o=doc.location.href.split(doc.location.origin)[1],l=e.params,p=l.pushState,c=l.pushStateOnLoad,d=l.pushStateSeparator,u=l.pushStateAnimateOnLoad,h=e.params.pushStateRoot;(win.cordova&&p&&!d&&!h&&doc.location.pathname.indexOf("index.html")&&(console.warn("Framework7: wrong or not complete pushState configuration, trying to guess pushStateRoot"),h=doc.location.pathname.split("index.html")[0]),p&&c?(h&&o.indexOf(h)>=0&&""===(o=o.split(h)[1])&&(o="/"),s=d.length>0&&o.indexOf(d)>=0?o.split(d)[1]:o,e.restoreHistory(),e.history.indexOf(s)>=0?e.history=e.history.slice(0,e.history.indexOf(s)+1):e.params.url===s?e.history=[s]:History.state&&History.state[a.id]&&History.state[a.id].url===e.history[e.history.length-1]?s=e.history[e.history.length-1]:e.history=[o.split(d)[0]||"/",s],e.history.length>1?r=!0:e.history=[],e.saveHistory()):(s||(s=o),doc.location.search&&s.indexOf("?")<0&&(s+=doc.location.search),doc.location.hash&&s.indexOf("#")<0&&(s+=doc.location.hash)),e.history.length>1?(i=e.findMatchingRoute(e.history[0]))||(i=Utils.extend(e.parseRouteUrl(e.history[0]),{route:{url:e.history[0],path:e.history[0].split("?")[0]}})):(i=e.findMatchingRoute(s))||(i=Utils.extend(e.parseRouteUrl(s),{route:{url:s,path:s.split("?")[0]}})),e.params.stackPages&&e.$el.children(".page").each(function(t,a){var r=$(a);e.initialPages.push(r[0]),e.separateNavbar&&r.children(".navbar").length>0&&e.initialNavbars.push(r.children(".navbar").find(".navbar-inner")[0])}),0===e.$el.children(".page:not(.stacked)").length&&s)?e.navigate(s,{initial:!0,reloadCurrent:!0,pushState:!1}):(e.currentRoute=i,e.$el.children(".page:not(.stacked)").each(function(t,a){var r,i=$(a);i.addClass("page-current"),e.separateNavbar&&((r=i.children(".navbar").children(".navbar-inner")).length>0?(e.$navbarEl.parents(doc).length||e.$el.prepend(e.$navbarEl),r.addClass("navbar-current"),e.$navbarEl.append(r),r.children(".title-large").length&&r.addClass("navbar-inner-large"),i.children(".navbar").remove()):(e.$navbarEl.addClass("navbar-hidden"),r.children(".title-large").length&&e.$navbarEl.addClass("navbar-hidden navbar-large-hidden"))),e.currentRoute&&e.currentRoute.route&&e.currentRoute.route.master&&e.params.masterDetailBreakpoint>0&&(i.addClass("page-master"),i.trigger("page:role",{role:"master"}),r&&r.length&&r.addClass("navbar-master"));var s={route:e.currentRoute};e.currentRoute&&e.currentRoute.route&&e.currentRoute.route.options&&Utils.extend(s,e.currentRoute.route.options),e.currentPageEl=i[0],e.separateNavbar&&r.length&&(e.currentNavbarEl=r[0]),e.removeThemeElements(i),e.separateNavbar&&r.length&&e.removeThemeElements(r),s.route.route.tab&&(n=!0,e.tabLoad(s.route.route.tab,Utils.extend({},s))),e.pageCallback("init",i,r,"current",void 0,s)}),r&&e.navigate(s,{initial:!0,pushState:!1,history:!1,animate:u,once:{pageAfterIn:function(){(e.params.preloadPreviousPage||e.params[t.theme+"SwipeBack"])&&e.history.length>2&&e.back({preload:!0})}}}),r||n||(e.history.push(s),e.saveHistory()));!(s&&p&&c)||History.state&&History.state[a.id]||History.initViewState(a.id,{url:s}),e.emit("local::init routerInit",e)},t.prototype.destroy=function(){var e=this;e.emit("local::destroy routerDestroy",e),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},t}(Framework7Class);Router.prototype.forward=forward,Router.prototype.load=load,Router.prototype.navigate=navigate,Router.prototype.refreshPage=refreshPage,Router.prototype.tabLoad=tabLoad,Router.prototype.tabRemove=tabRemove,Router.prototype.modalLoad=modalLoad,Router.prototype.modalRemove=modalRemove,Router.prototype.backward=backward,Router.prototype.loadBack=loadBack,Router.prototype.back=back,Router.prototype.clearPreviousPages=clearPreviousPages,Router.prototype.clearPreviousHistory=clearPreviousHistory;var RouterModule={name:"router",static:{Router:Router},instance:{cache:{xhr:[],templates:[],components:[]}},create:function(){this.app?this.params.router&&(this.router=new Router(this.app,this)):this.router=new Router(this)}},View=function(e){function t(t,a,r){void 0===r&&(r={}),e.call(this,r,[t]);var i,n,s,o=t,l=$(a),p=this;return p.params=Utils.extend({routes:[],routesAdd:[]},o.params.view,r),p.params.routes.length>0?p.routes=p.params.routes:p.routes=[].concat(o.routes,p.params.routesAdd),i="string"==typeof a?a:(l.attr("id")?"#"+l.attr("id"):"")+(l.attr("class")?"."+l.attr("class").replace(/ /g,".").replace(".active",""):""),"ios"===o.theme&&p.params.iosDynamicNavbar&&p.params.iosSeparateDynamicNavbar&&0===(n=l.children(".navbar").eq(0)).length&&(n=$('<div class="navbar"></div>')),Utils.extend(!1,p,{app:o,$el:l,el:l[0],name:p.params.name,main:p.params.main||l.hasClass("view-main"),$navbarEl:n,navbarEl:n?n[0]:void 0,selector:i,history:[],scrollHistory:{}}),l[0].f7View=p,p.useModules(),o.views.push(p),p.main&&(o.views.main=p),p.name&&(o.views[p.name]=p),p.index=o.views.indexOf(p),s=p.name?"view_"+p.name:p.main?"view_main":"view_"+p.index,p.id=s,o.initialized?p.init():o.on("init",function(){p.init()}),p}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.destroy=function(){var e=this,t=e.app;e.$el.trigger("view:beforedestroy",e),e.emit("local::beforeDestroy viewBeforeDestroy",e),t.off("resize",e.checkmasterDetailBreakpoint),e.main?(t.views.main=null,delete t.views.main):e.name&&(t.views[e.name]=null,delete t.views[e.name]),e.$el[0].f7View=null,delete e.$el[0].f7View,t.views.splice(t.views.indexOf(e),1),e.params.router&&e.router&&e.router.destroy(),e.emit("local::destroy viewDestroy",e),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},t.prototype.checkmasterDetailBreakpoint=function(){var e=this.app,t=this.$el.hasClass("view-master-detail");e.width>=this.params.masterDetailBreakpoint?(this.$el.addClass("view-master-detail"),t||(this.emit("local::masterDetailBreakpoint viewMasterDetailBreakpoint"),this.$el.trigger("view:masterDetailBreakpoint",this))):(this.$el.removeClass("view-master-detail"),t&&(this.emit("local::masterDetailBreakpoint viewMasterDetailBreakpoint"),this.$el.trigger("view:masterDetailBreakpoint",this)))},t.prototype.initMasterDetail=function(){var e=this.app;this.checkmasterDetailBreakpoint=this.checkmasterDetailBreakpoint.bind(this),this.checkmasterDetailBreakpoint(),e.on("resize",this.checkmasterDetailBreakpoint)},t.prototype.init=function(){this.params.router&&(this.params.masterDetailBreakpoint>0&&this.initMasterDetail(),this.router.init(),this.$el.trigger("view:init",this),this.emit("local::init viewInit",this))},t}(Framework7Class);function initClicks(e){e.on("click",function(t){var a=$(t.target),r=a.closest("a"),i=r.length>0,n=i&&r.attr("href");if(i&&(r.is(e.params.clicks.externalLinks)||n&&n.indexOf("javascript:")>=0)){var s=r.attr("target");n&&win.cordova&&win.cordova.InAppBrowser&&("_system"===s||"_blank"===s)&&(t.preventDefault(),win.cordova.InAppBrowser.open(n,s))}else{Object.keys(e.modules).forEach(function(r){var i=e.modules[r].clicks;i&&(t.preventF7Router||Object.keys(i).forEach(function(r){var n=a.closest(r).eq(0);n.length>0&&i[r].call(e,n,n.dataset(),t)}))});var o={};if(i&&(t.preventDefault(),o=r.dataset()),!t.preventF7Router&&!r.hasClass("prevent-router")&&!r.hasClass("router-prevent")&&(n&&n.length>0&&"#"!==n[0]||r.hasClass("back"))){var l;if(o.view?l=$(o.view)[0].f7View:(l=a.parents(".view")[0]&&a.parents(".view")[0].f7View,!r.hasClass("back")&&l&&l.params.linksView&&("string"==typeof l.params.linksView?l=$(l.params.linksView)[0].f7View:l.params.linksView instanceof View&&(l=l.params.linksView))),l||e.views.main&&(l=e.views.main),!l||!l.router)return;if(o.context&&"string"==typeof o.context)try{o.context=JSON.parse(o.context)}catch(e){}r[0].f7RouteProps&&(o.props=r[0].f7RouteProps),r.hasClass("back")?l.router.back(n,o):l.router.navigate(n,o)}}})}View.use(RouterModule);var ClicksModule={name:"clicks",params:{clicks:{externalLinks:".external"}},on:{init:function(){initClicks(this)}}},RouterTemplateLoaderModule={name:"routerTemplateLoader",proto:{templateLoader:function(e,t,a,r,i){var n=this;function s(e){var t,s;try{if("function"==typeof(s=a.context||{}))s=s.call(n);else if("string"==typeof s)try{s=JSON.parse(s)}catch(e){throw i(),e}t="function"==typeof e?e(s):Template7.compile(e)(Utils.extend({},s||{},{$app:n.app,$root:Utils.extend({},n.app.data,n.app.methods),$route:a.route,$f7route:a.route,$router:n,$f7router:n,$theme:{ios:"ios"===n.app.theme,md:"md"===n.app.theme,aurora:"aurora"===n.app.theme}}))}catch(e){throw i(),e}r(t,{context:s})}t?(n.xhr&&(n.xhr.abort(),n.xhr=!1),n.xhrRequest(t,a).then(function(e){s(e)}).catch(function(){i()})):s(e)},modalTemplateLoader:function(e,t,a,r,i){return this.templateLoader(e,t,a,function(e){r(e)},i)},tabTemplateLoader:function(e,t,a,r,i){return this.templateLoader(e,t,a,function(e){r(e)},i)},pageTemplateLoader:function(e,t,a,r,i){var n=this;return n.templateLoader(e,t,a,function(e,t){void 0===t&&(t={}),r(n.getPageEl(e),t)},i)}}},RouterComponentLoaderModule={name:"routerComponentLoader",proto:{componentLoader:function(e,t,a,r,i){void 0===a&&(a={});var n,s=this,o=s.app,l="string"==typeof e?e:t,p=s.replaceRequestUrlParams(l,a);function c(e){var t=a.context||{};if("function"==typeof t)t=t.call(s);else if("string"==typeof t)try{t=JSON.parse(t)}catch(e){throw i(),e}var n=Utils.merge({},t,{$route:a.route,$f7route:a.route,$router:s,$f7router:s,$theme:{ios:"ios"===o.theme,md:"md"===o.theme,aurora:"aurora"===o.theme}}),l=o.component.create(e,n);r(l.el)}p&&s.cache.components.forEach(function(e){e.url===p&&(n=e.component)}),p&&n?c(n):p&&!n?(s.xhr&&(s.xhr.abort(),s.xhr=!1),s.xhrRequest(l,a).then(function(e){var t=o.component.parse(e);s.cache.components.push({url:p,component:t}),c(t)}).catch(function(e){throw i(),e})):c(e)},modalComponentLoader:function(e,t,a,r,i,n){this.componentLoader(t,a,r,function(e){i(e)},n)},tabComponentLoader:function(e,t,a,r,i,n){this.componentLoader(t,a,r,function(e){i(e)},n)},pageComponentLoader:function(e,t,a,r,i,n){this.componentLoader(t,a,r,function(e,t){void 0===t&&(t={}),i(e,t)},n)}}},HistoryModule={name:"history",static:{history:History},on:{init:function(){History.init(this)}}},keyPrefix="f7storage-",Storage={get:function(e){return new Promise(function(t,a){try{t(JSON.parse(win.localStorage.getItem(""+keyPrefix+e)))}catch(e){a(e)}})},set:function(e,t){return new Promise(function(a,r){try{win.localStorage.setItem(""+keyPrefix+e,JSON.stringify(t)),a()}catch(e){r(e)}})},remove:function(e){return new Promise(function(t,a){try{win.localStorage.removeItem(""+keyPrefix+e),t()}catch(e){a(e)}})},clear:function(){},length:function(){},keys:function(){return new Promise(function(e,t){try{e(Object.keys(win.localStorage).filter(function(e){return 0===e.indexOf(keyPrefix)}).map(function(e){return e.replace(keyPrefix,"")}))}catch(e){t(e)}})},forEach:function(e){return new Promise(function(t,a){try{Object.keys(win.localStorage).filter(function(e){return 0===e.indexOf(keyPrefix)}).forEach(function(t,a){var r=t.replace(keyPrefix,"");Storage.get(r).then(function(t){e(r,t,a)})}),t()}catch(e){a(e)}})}},StorageModule={name:"storage",static:{Storage:Storage,storage:Storage}};function vnode(e,t,a,r,i){return{sel:e,data:t,children:a,text:r,elm:i,key:void 0===t?void 0:t.key}}var array=Array.isArray;function primitive(e){return"string"==typeof e||"number"==typeof e}function addNS(e,t,a){if(e.ns="http://www.w3.org/2000/svg","foreignObject"!==a&&void 0!==t)for(var r=0;r<t.length;++r){var i=t[r].data;void 0!==i&&addNS(i,t[r].children,t[r].sel)}}function h(e,t,a){var r,i,n,s={};if(void 0!==a?(s=t,array(a)?r=a:primitive(a)?i=a:a&&a.sel&&(r=[a])):void 0!==t&&(array(t)?r=t:primitive(t)?i=t:t&&t.sel?r=[t]:s=t),array(r))for(n=0;n<r.length;++n)primitive(r[n])&&(r[n]=vnode(void 0,void 0,void 0,r[n],void 0));return"s"!==e[0]||"v"!==e[1]||"g"!==e[2]||3!==e.length&&"."!==e[3]&&"#"!==e[3]||addNS(s,r,e),vnode(e,s,r,i,void 0)}var selfClosing="area base br col command embed hr img input keygen link menuitem meta param source track wbr".split(" "),propsAttrs="hidden checked disabled readonly selected autocomplete autofocus autoplay required multiple value indeterminate".split(" "),booleanProps="hidden checked disabled readonly selected autocomplete autofocus autoplay required multiple readOnly indeterminate".split(" "),tempDom=doc.createElement("div");function getHooks(e,t,a,r){var i={};if(!e||!e.attrs||!e.attrs.class)return i;var n=e.attrs.class,s=[],o=[],l=[],p=[];return n.split(" ").forEach(function(e){a||s.push.apply(s,t.getVnodeHooks("insert",e)),o.push.apply(o,t.getVnodeHooks("destroy",e)),l.push.apply(l,t.getVnodeHooks("update",e)),p.push.apply(p,t.getVnodeHooks("postpatch",e))}),r&&!a&&p.push(function(e,t){var a=t||e;a&&a.data&&a.data.context&&a.data.context.$options.updated&&a.data.context.$options.updated()}),0===s.length&&0===o.length&&0===l.length&&0===p.length?i:(s.length&&(i.insert=function(e){s.forEach(function(t){return t(e)})}),o.length&&(i.destroy=function(e){o.forEach(function(t){return t(e)})}),l.length&&(i.update=function(e,t){l.forEach(function(a){return a(e,t)})}),p.length&&(i.postpatch=function(e,t){p.forEach(function(a){return a(e,t)})}),i)}function getEventHandler(e,t,a){void 0===a&&(a={});var r,i,n=a.stop,s=a.prevent,o=a.once,l=!1,p=[],c=!0;if((r=e.indexOf("(")<0?e:e.split("(")[0]).indexOf(".")>=0)r.split(".").forEach(function(e,a){if(0!==a||"this"!==e){if(0===a&&"window"===e)return i=win,void(c=!1);if(i||(i=t),!i[e])throw new Error("Framework7: Component doesn't have method \""+r.split(".").slice(0,a+1).join(".")+'"');i=i[e]}});else{if(!t[r])throw new Error("Framework7: Component doesn't have method \""+r+'"');i=t[r]}return c&&(i=i.bind(t)),function(){for(var a=[],r=arguments.length;r--;)a[r]=arguments[r];var c=a[0];o&&l||(n&&c.stopPropagation(),s&&c.preventDefault(),l=!0,e.indexOf("(")<0?p=a:e.split("(")[1].split(")")[0].replace(/'[^']*'|"[^"]*"/g,function(e){return e.replace(/,/g,"<_comma_>")}).split(",").map(function(e){return e.replace(/<_comma_>/g,",")}).forEach(function(e){var a=e.trim();if(isNaN(a))if("true"===a)a=!0;else if("false"===a)a=!1;else if("null"===a)a=null;else if("undefined"===a)a=void 0;else if('"'===a[0])a=a.replace(/"/g,"");else if("'"===a[0])a=a.replace(/'/g,"");else if(a.indexOf(".")>0){var r;a.split(".").forEach(function(e){r||(r=t),r=r[e]}),a=r}else a=t[a];else a=parseFloat(a);p.push(a)}),i.apply(void 0,p))}}function getData(e,t,a,r,i){var n={context:t},s=e.attributes;Array.prototype.forEach.call(s,function(e){var a=e.name,r=e.value;if(propsAttrs.indexOf(a)>=0)n.props||(n.props={}),"readonly"===a&&(a="readOnly"),booleanProps.indexOf(a)>=0?n.props[a]=!1!==r:n.props[a]=r;else if("key"===a)n.key=r;else if(0===a.indexOf("@")){n.on||(n.on={});var s=a.substr(1),o=!1,l=!1,p=!1;s.indexOf(".")>=0&&s.split(".").forEach(function(e,t){0===t?s=e:("stop"===e&&(o=!0),"prevent"===e&&(l=!0),"once"===e&&(p=!0))}),n.on[s]=getEventHandler(r,t,{stop:o,prevent:l,once:p})}else if("style"===a)if(r.indexOf("{")>=0&&r.indexOf("}")>=0)try{n.style=JSON.parse(r)}catch(e){n.attrs||(n.attrs={}),n.attrs.style=r}else n.attrs||(n.attrs={}),n.attrs.style=r;else n.attrs||(n.attrs={}),n.attrs[a]=r,"id"!==a||n.key||i||(n.key=r)});var o=getHooks(n,a,r,i);return o.prepatch=function(e,t){e&&t&&e&&e.data&&e.data.props&&Object.keys(e.data.props).forEach(function(a){booleanProps.indexOf(a)<0||(t.data||(t.data={}),t.data.props||(t.data.props={}),!0!==e.data.props[a]||a in t.data.props||(t.data.props[a]=!1))})},o&&(n.hook=o),n}function getChildren(e,t,a,r){for(var i=[],n=e.childNodes,s=0;s<n.length;s+=1){var o=elementToVNode(n[s],t,a,r);o&&i.push(o)}return i}function elementToVNode(e,t,a,r,i){if(1===e.nodeType){var n=e instanceof win.SVGElement?e.nodeName:e.nodeName.toLowerCase();return h(n,getData(e,t,a,r,i),selfClosing.indexOf(n)>=0?[]:getChildren(e,t,a,r))}return 3===e.nodeType?e.textContent:null}function vdom(e,t,a,r){var i;void 0===e&&(e=""),tempDom.innerHTML=e.trim();for(var n=0;n<tempDom.childNodes.length;n+=1)i||1!==tempDom.childNodes[n].nodeType||(i=tempDom.childNodes[n]);var s=elementToVNode(i,t,a,r,!0);return tempDom.innerHTML="",s}function createElement(e){return document.createElement(e)}function createElementNS(e,t){return document.createElementNS(e,t)}function createTextNode(e){return document.createTextNode(e)}function createComment(e){return document.createComment(e)}function insertBefore$1(e,t,a){e.insertBefore(t,a)}function removeChild(e,t){e&&e.removeChild(t)}function appendChild(e,t){e.appendChild(t)}function parentNode(e){return e.parentNode}function nextSibling(e){return e.nextSibling}function tagName(e){return e.tagName}function setTextContent(e,t){e.textContent=t}function getTextContent(e){return e.textContent}function isElement(e){return 1===e.nodeType}function isText(e){return 3===e.nodeType}function isComment(e){return 8===e.nodeType}var htmlDomApi={createElement:createElement,createElementNS:createElementNS,createTextNode:createTextNode,createComment:createComment,insertBefore:insertBefore$1,removeChild:removeChild,appendChild:appendChild,parentNode:parentNode,nextSibling:nextSibling,tagName:tagName,setTextContent:setTextContent,getTextContent:getTextContent,isElement:isElement,isText:isText,isComment:isComment};function isUndef(e){return void 0===e}function isDef(e){return void 0!==e}var emptyNode=vnode("",{},[],void 0,void 0);function sameVnode(e,t){return e.key===t.key&&e.sel===t.sel}function isVnode(e){return void 0!==e.sel}function createKeyToOldIdx(e,t,a){var r,i,n,s={};for(r=t;r<=a;++r)null!=(n=e[r])&&void 0!==(i=n.key)&&(s[i]=r);return s}var hooks=["create","update","remove","destroy","pre","post"];function init(e,t){var a,r,i={},n=void 0!==t?t:htmlDomApi;for(a=0;a<hooks.length;++a)for(i[hooks[a]]=[],r=0;r<e.length;++r){var s=e[r][hooks[a]];void 0!==s&&i[hooks[a]].push(s)}function o(e){var t=e.id?"#"+e.id:"",a=e.className?"."+e.className.split(" ").join("."):"";return vnode(n.tagName(e).toLowerCase()+t+a,{},[],void 0,e)}function l(e,t){return function(){if(0==--t){var a=n.parentNode(e);n.removeChild(a,e)}}}function p(e,t){var a,r=e.data;void 0!==r&&isDef(a=r.hook)&&isDef(a=a.init)&&(a(e),r=e.data);var s=e.children,o=e.sel;if("!"===o)isUndef(e.text)&&(e.text=""),e.elm=n.createComment(e.text);else if(void 0!==o){var l=o.indexOf("#"),c=o.indexOf(".",l),d=l>0?l:o.length,u=c>0?c:o.length,h=-1!==l||-1!==c?o.slice(0,Math.min(d,u)):o,f=e.elm=isDef(r)&&isDef(a=r.ns)?n.createElementNS(a,h):n.createElement(h);for(d<u&&f.setAttribute("id",o.slice(d+1,u)),c>0&&f.setAttribute("class",o.slice(u+1).replace(/\./g," ")),a=0;a<i.create.length;++a)i.create[a](emptyNode,e);if(array(s))for(a=0;a<s.length;++a){var v=s[a];null!=v&&n.appendChild(f,p(v,t))}else primitive(e.text)&&n.appendChild(f,n.createTextNode(e.text));isDef(a=e.data.hook)&&(a.create&&a.create(emptyNode,e),a.insert&&t.push(e))}else e.elm=n.createTextNode(e.text);return e.elm}function c(e,t,a,r,i,s){for(;r<=i;++r){var o=a[r];null!=o&&n.insertBefore(e,p(o,s),t)}}function d(e){var t,a,r=e.data;if(void 0!==r){for(isDef(t=r.hook)&&isDef(t=t.destroy)&&t(e),t=0;t<i.destroy.length;++t)i.destroy[t](e);if(void 0!==e.children)for(a=0;a<e.children.length;++a)null!=(t=e.children[a])&&"string"!=typeof t&&d(t)}}function u(e,t,a,r){for(;a<=r;++a){var s=void 0,o=void 0,p=void 0,c=t[a];if(null!=c)if(isDef(c.sel)){for(d(c),o=i.remove.length+1,p=l(c.elm,o),s=0;s<i.remove.length;++s)i.remove[s](c,p);isDef(s=c.data)&&isDef(s=s.hook)&&isDef(s=s.remove)?s(c,p):p()}else n.removeChild(e,c.elm)}}function h(e,t,a){var r,s;isDef(r=t.data)&&isDef(s=r.hook)&&isDef(r=s.prepatch)&&r(e,t);var o=t.elm=e.elm,l=e.children,d=t.children;if(e!==t){if(void 0!==t.data){for(r=0;r<i.update.length;++r)i.update[r](e,t);isDef(r=t.data.hook)&&isDef(r=r.update)&&r(e,t)}isUndef(t.text)?isDef(l)&&isDef(d)?l!==d&&function(e,t,a,r){for(var i,s,o,l=0,d=0,f=t.length-1,v=t[0],m=t[f],g=a.length-1,b=a[0],y=a[g];l<=f&&d<=g;)null==v?v=t[++l]:null==m?m=t[--f]:null==b?b=a[++d]:null==y?y=a[--g]:sameVnode(v,b)?(h(v,b,r),v=t[++l],b=a[++d]):sameVnode(m,y)?(h(m,y,r),m=t[--f],y=a[--g]):sameVnode(v,y)?(h(v,y,r),n.insertBefore(e,v.elm,n.nextSibling(m.elm)),v=t[++l],y=a[--g]):sameVnode(m,b)?(h(m,b,r),n.insertBefore(e,m.elm,v.elm),m=t[--f],b=a[++d]):(void 0===i&&(i=createKeyToOldIdx(t,l,f)),isUndef(s=i[b.key])?(n.insertBefore(e,p(b,r),v.elm),b=a[++d]):((o=t[s]).sel!==b.sel?n.insertBefore(e,p(b,r),v.elm):(h(o,b,r),t[s]=void 0,n.insertBefore(e,o.elm,v.elm)),b=a[++d]));(l<=f||d<=g)&&(l>f?c(e,null==a[g+1]?null:a[g+1].elm,a,d,g,r):u(e,t,l,f))}(o,l,d,a):isDef(d)?(isDef(e.text)&&n.setTextContent(o,""),c(o,null,d,0,d.length-1,a)):isDef(l)?u(o,l,0,l.length-1):isDef(e.text)&&n.setTextContent(o,""):e.text!==t.text&&n.setTextContent(o,t.text),isDef(s)&&isDef(r=s.postpatch)&&r(e,t)}}return function(e,t){var a,r,s,l=[];for(a=0;a<i.pre.length;++a)i.pre[a]();for(isVnode(e)||(e=o(e)),sameVnode(e,t)?h(e,t,l):(r=e.elm,s=n.parentNode(r),p(t,l),null!==s&&(n.insertBefore(s,t.elm,n.nextSibling(r)),u(s,[e],0,0))),a=0;a<l.length;++a)l[a].data.hook.insert(l[a]);for(a=0;a<i.post.length;++a)i.post[a]();return t}}var xlinkNS="http://www.w3.org/1999/xlink",xmlNS="http://www.w3.org/XML/1998/namespace",colonChar=58,xChar=120;function updateAttrs(e,t){var a,r=t.elm,i=e.data.attrs,n=t.data.attrs;if((i||n)&&i!==n){for(a in i=i||{},n=n||{}){var s=n[a];i[a]!==s&&(!0===s?r.setAttribute(a,""):!1===s?r.removeAttribute(a):a.charCodeAt(0)!==xChar?r.setAttribute(a,s):a.charCodeAt(3)===colonChar?r.setAttributeNS(xmlNS,a,s):a.charCodeAt(5)===colonChar?r.setAttributeNS(xlinkNS,a,s):r.setAttribute(a,s))}for(a in i)a in n||r.removeAttribute(a)}}var attributesModule={create:updateAttrs,update:updateAttrs};function updateProps(e,t){var a,r,i=t.elm,n=e.data.props,s=t.data.props;if((n||s)&&n!==s){for(a in s=s||{},n=n||{})s[a]||delete i[a];for(a in s)r=s[a],n[a]===r||"value"===a&&i[a]===r||(i[a]=r)}}var propsModule={create:updateProps,update:updateProps},raf="undefined"!=typeof window&&window.requestAnimationFrame||setTimeout,nextFrame=function(e){raf(function(){raf(e)})};function setNextFrame(e,t,a){nextFrame(function(){e[t]=a})}function updateStyle(e,t){var a,r,i=t.elm,n=e.data.style,s=t.data.style;if((n||s)&&n!==s){s=s||{};var o="delayed"in(n=n||{});for(r in n)s[r]||("-"===r[0]&&"-"===r[1]?i.style.removeProperty(r):i.style[r]="");for(r in s)if(a=s[r],"delayed"===r&&s.delayed)for(var l in s.delayed)a=s.delayed[l],o&&a===n.delayed[l]||setNextFrame(i.style,l,a);else"remove"!==r&&a!==n[r]&&("-"===r[0]&&"-"===r[1]?i.style.setProperty(r,a):i.style[r]=a)}}function applyDestroyStyle(e){var t,a,r=e.elm,i=e.data.style;if(i&&(t=i.destroy))for(a in t)r.style[a]=t[a]}function applyRemoveStyle(e,t){var a=e.data.style;if(a&&a.remove){var r,i=e.elm,n=0,s=a.remove,o=0,l=[];for(r in s)l.push(r),i.style[r]=s[r];for(var p=getComputedStyle(i)["transition-property"].split(", ");n<p.length;++n)-1!==l.indexOf(p[n])&&o++;i.addEventListener("transitionend",function(e){e.target===i&&--o,0===o&&t()})}else t()}var styleModule={create:updateStyle,update:updateStyle,destroy:applyDestroyStyle,remove:applyRemoveStyle};function invokeHandler(e,t,a){"function"==typeof e&&e.apply(void 0,[t].concat(a))}function handleEvent(e,t,a){var r=e.type,i=a.data.on;i&&i[r]&&invokeHandler(i[r],e,t)}function createListener(){return function e(t){for(var a=[],r=arguments.length-1;r-- >0;)a[r]=arguments[r+1];handleEvent(t,a,e.vnode)}}function updateEvents(e,t){var a=e.data.on,r=e.listener,i=e.elm,n=t&&t.data.on,s=t&&t.elm;if(a!==n&&(a&&r&&(n?Object.keys(a).forEach(function(e){n[e]||$(i).off(e,r)}):Object.keys(a).forEach(function(e){$(i).off(e,r)})),n)){var o=e.listener||createListener();t.listener=o,o.vnode=t,a?Object.keys(n).forEach(function(e){a[e]||$(s).on(e,o)}):Object.keys(n).forEach(function(e){$(s).on(e,o)})}}var eventListenersModule={create:updateEvents,update:updateEvents,destroy:updateEvents},patch=init([attributesModule,propsModule,styleModule,eventListenersModule]),Framework7Component=function(e,t,a){void 0===a&&(a={});var r=Utils.id(),i=Utils.merge(this,a,{$:$,$$:$,$dom7:$,$app:e,$f7:e,$options:Utils.extend({id:r},t),$id:t.id||r}),n=i.$options;Object.defineProperty(i,"$root",{enumerable:!0,configurable:!0,get:function(){var t=Utils.merge({},e.data,e.methods);return win&&win.Proxy&&(t=new win.Proxy(t,{set:function(t,a,r){e.data[a]=r},deleteProperty:function(t,a){delete e.data[a],delete e.methods[a]},has:function(t,a){return a in e.data||a in e.methods}})),t},set:function(){}}),"beforeCreate created beforeMount mounted beforeDestroy destroyed updated".split(" ").forEach(function(e){n[e]&&(n[e]=n[e].bind(i))}),n.data&&(n.data=n.data.bind(i),Utils.extend(i,n.data())),n.render&&(n.render=n.render.bind(i)),n.methods&&Object.keys(n.methods).forEach(function(e){i[e]=n.methods[e].bind(i)}),n.on&&Object.keys(n.on).forEach(function(e){n.on[e]=n.on[e].bind(i)}),n.once&&Object.keys(n.once).forEach(function(e){n.once[e]=n.once[e].bind(i)}),n.beforeCreate&&n.beforeCreate();var s=i.$render();return s&&"string"==typeof s?(s=s.trim(),i.$vnode=vdom(s,i,e,!0),i.el=doc.createElement(i.$vnode.sel||"div"),patch(i.el,i.$vnode)):s&&(i.el=s),i.$el=$(i.el),n.style&&(i.$styleEl=doc.createElement("style"),i.$styleEl.innerHTML=n.style,n.styleScoped&&i.el.setAttribute("data-f7-"+n.id,"")),i.$attachEvents(),n.created&&n.created(),i.el.f7Component=i,i};function parseComponent(e){var t,a=Utils.id(),r="f7_component_create_callback_"+a,i="f7_component_render_callback_"+a,n=e.match(/<template([ ]?)([a-z0-9-]*)>/),s=n[2]||"t7";n&&(t=e.split(/<template[ ]?[a-z0-9-]*>/).filter(function(e,t){return t>0}).join("<template>").split("</template>").filter(function(e,t,a){return t<a.length-1}).join("</template>").replace(/{{#raw}}([ \n]*)<template/g,"{{#raw}}<template").replace(/\/template>([ \n]*){{\/raw}}/g,"/template>{{/raw}}").replace(/([ \n])<template/g,"$1{{#raw}}<template").replace(/\/template>([ \n])/g,"/template>{{/raw}}$1"));var o,l,p=null,c=!1;if(e.indexOf("<style>")>=0?p=e.split("<style>")[1].split("</style>")[0]:e.indexOf("<style scoped>")>=0&&(c=!0,p=(p=e.split("<style scoped>")[1].split("</style>")[0]).replace(/{{this}}/g,"[data-f7-"+a+"]").replace(/[\n]?([^{^}]*){/gi,function(e,t){return"\n"+(t=t.split(",").map(function(e){return e.indexOf("[data-f7-"+a+"]")>=0?e:"[data-f7-"+a+"] "+e.trim()}).join(", "))+" {"})),e.indexOf("<script>")>=0){var d=e.split("<script>");o=d[d.length-1].split("<\/script>")[0].trim()}else o="return {}";o&&o.trim()||(o="return {}"),o="window."+r+" = function () {"+o+"}",(l=doc.createElement("script")).innerHTML=o,$("head").append(l);var u=win[r]();if($(l).remove(),win[r]=null,delete win[r],u.template||u.render||(u.template=t,u.templateType=s),u.template&&("t7"===u.templateType&&(u.template=Template7.compile(u.template)),"es"===u.templateType)){var h="window."+i+" = function () {\n        return function render() {\n          return `"+u.template+"`;\n        }\n      }";(l=doc.createElement("script")).innerHTML=h,$("head").append(l),u.render=win[i](),$(l).remove(),win[i]=null,delete win[i]}return p&&(u.style=p,u.styleScoped=c),u.id=a,u}Framework7Component.prototype.$attachEvents=function(){var e=this.$options,t=this.$el;e.on&&Object.keys(e.on).forEach(function(a){t.on(Utils.eventNameToColonCase(a),e.on[a])}),e.once&&Object.keys(e.once).forEach(function(a){t.once(Utils.eventNameToColonCase(a),e.once[a])})},Framework7Component.prototype.$detachEvents=function(){var e=this.$options,t=this.$el;e.on&&Object.keys(e.on).forEach(function(a){t.off(Utils.eventNameToColonCase(a),e.on[a])}),e.once&&Object.keys(e.once).forEach(function(a){t.off(Utils.eventNameToColonCase(a),e.once[a])})},Framework7Component.prototype.$render=function(){var e=this.$options,t="";if(e.render)t=e.render();else if(e.template)if("string"==typeof e.template)try{t=Template7.compile(e.template)(this)}catch(e){throw e}else t=e.template(this);return t},Framework7Component.prototype.$forceUpdate=function(){var e=this.$render();if(e&&"string"==typeof e){var t=vdom(e=e.trim(),this,this.$app);this.$vnode=patch(this.$vnode,t)}},Framework7Component.prototype.$setState=function(e){Utils.merge(this,e),this.$forceUpdate()},Framework7Component.prototype.$mount=function(e){this.$options.beforeMount&&this.$options.beforeMount(),this.$styleEl&&$("head").append(this.$styleEl),e&&e(this.el),this.$options.mounted&&this.$options.mounted()},Framework7Component.prototype.$destroy=function(){this.$options.beforeDestroy&&this.$options.beforeDestroy(),this.$styleEl&&$(this.$styleEl).remove(),this.$detachEvents(),this.$options.destroyed&&this.$options.destroyed(),this.el&&this.el.f7Component&&(this.el.f7Component=null,delete this.el.f7Component),this.$vnode&&(this.$vnode=patch(this.$vnode,{sel:this.$vnode.sel,data:{}})),Utils.deleteProps(this)};var ComponentModule={name:"component",create:function(){var e=this;e.component={parse:function(e){return parseComponent(e)},create:function(t,a){return new Framework7Component(e,t,a)}}}},SW={registrations:[],register:function(e,t){var a=this;return"serviceWorker"in window.navigator&&a.serviceWorker.container?new Promise(function(r,i){a.serviceWorker.container.register(e,t?{scope:t}:{}).then(function(e){SW.registrations.push(e),a.emit("serviceWorkerRegisterSuccess",e),r(e)}).catch(function(e){a.emit("serviceWorkerRegisterError",e),i(e)})}):new Promise(function(e,t){t(new Error("Service worker is not supported"))})},unregister:function(e){var t,a=this;return"serviceWorker"in window.navigator&&a.serviceWorker.container?(t=e?Array.isArray(e)?e:[e]:SW.registrations,Promise.all(t.map(function(e){return new Promise(function(t,r){e.unregister().then(function(){SW.registrations.indexOf(e)>=0&&SW.registrations.splice(SW.registrations.indexOf(e),1),a.emit("serviceWorkerUnregisterSuccess",e),t()}).catch(function(t){a.emit("serviceWorkerUnregisterError",e,t),r(t)})})}))):new Promise(function(e,t){t(new Error("Service worker is not supported"))})}},ServiceWorkerModule={name:"sw",params:{serviceWorker:{path:void 0,scope:void 0}},create:function(){Utils.extend(this,{serviceWorker:{container:"serviceWorker"in window.navigator?window.navigator.serviceWorker:void 0,registrations:SW.registrations,register:SW.register.bind(this),unregister:SW.unregister.bind(this)}})},on:{init:function(){if("serviceWorker"in window.navigator){var e=this;if(e.serviceWorker.container){var t=e.params.serviceWorker.path,a=e.params.serviceWorker.scope;if(t&&(!Array.isArray(t)||t.length))(Array.isArray(t)?t:[t]).forEach(function(t){e.serviceWorker.register(t,a)})}}}}},Statusbar={hide:function(){$("html").removeClass("with-statusbar"),Device.cordova&&win.StatusBar&&win.StatusBar.hide()},show:function(){if(Device.cordova&&win.StatusBar)return win.StatusBar.show(),void Utils.nextTick(function(){Device.needsStatusbarOverlay()&&$("html").addClass("with-statusbar")});$("html").addClass("with-statusbar")},onClick:function(){var e;(e=$(".popup.modal-in").length>0?$(".popup.modal-in").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".panel.panel-active").length>0?$(".panel.panel-active").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".views > .view.tab-active").length>0?$(".views > .view.tab-active").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):$(".views").length>0?$(".views").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"):this.root.children(".view").find(".page:not(.page-previous):not(.page-next):not(.cached)").find(".page-content"))&&e.length>0&&(e.hasClass("tab")&&(e=e.parent(".tabs").children(".page-content.tab-active")),e.length>0&&e.scrollTop(0,300))},setTextColor:function(e){Device.cordova&&win.StatusBar&&("white"===e?win.StatusBar.styleLightContent():win.StatusBar.styleDefault())},setIosTextColor:function(e){Device.ios&&Statusbar.setTextColor(e)},setBackgroundColor:function(e){$(".statusbar").css("background-color",e),Device.cordova&&win.StatusBar&&win.StatusBar.backgroundColorByHexString(e)},isVisible:function(){return!(!Device.cordova||!win.StatusBar)&&win.StatusBar.isVisible},overlaysWebView:function(e){void 0===e&&(e=!0),Device.cordova&&win.StatusBar&&(win.StatusBar.overlaysWebView(e),e?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar"))},checkOverlay:function(){Device.needsStatusbarOverlay()?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar")},init:function(){var e=this.params.statusbar;e.enabled&&("auto"===e.overlay?(Device.needsStatusbarOverlay()?$("html").addClass("with-statusbar"):$("html").removeClass("with-statusbar"),Device.ios&&(Device.cordova||Device.webView)&&(0===win.orientation&&this.once("resize",function(){Statusbar.checkOverlay()}),$(doc).on("resume",function(){Statusbar.checkOverlay()},!1),this.on(Device.ios?"orientationchange":"orientationchange resize",function(){Statusbar.checkOverlay()}))):!0===e.overlay?$("html").addClass("with-statusbar"):!1===e.overlay&&$("html").removeClass("with-statusbar"),Device.cordova&&win.StatusBar&&(e.scrollTopOnClick&&$(win).on("statusTap",Statusbar.onClick.bind(this)),Device.ios&&(e.iosOverlaysWebView?win.StatusBar.overlaysWebView(!0):win.StatusBar.overlaysWebView(!1),"white"===e.iosTextColor?win.StatusBar.styleLightContent():win.StatusBar.styleDefault()),Device.android&&(e.androidOverlaysWebView?win.StatusBar.overlaysWebView(!0):win.StatusBar.overlaysWebView(!1),"white"===e.androidTextColor?win.StatusBar.styleLightContent():win.StatusBar.styleDefault())),e.iosBackgroundColor&&Device.ios&&Statusbar.setBackgroundColor(e.iosBackgroundColor),(e.materialBackgroundColor||e.androidBackgroundColor)&&Device.android&&Statusbar.setBackgroundColor(e.materialBackgroundColor||e.androidBackgroundColor))}},Statusbar$1={name:"statusbar",params:{statusbar:{enabled:!0,overlay:"auto",scrollTopOnClick:!0,iosOverlaysWebView:!0,iosTextColor:"black",iosBackgroundColor:null,androidOverlaysWebView:!1,androidTextColor:"black",androidBackgroundColor:null}},create:function(){Utils.extend(this,{statusbar:{checkOverlay:Statusbar.checkOverlay,hide:Statusbar.hide,show:Statusbar.show,overlaysWebView:Statusbar.overlaysWebView,setTextColor:Statusbar.setTextColor,setBackgroundColor:Statusbar.setBackgroundColor,isVisible:Statusbar.isVisible,init:Statusbar.init.bind(this)}})},on:{init:function(){Statusbar.init.call(this)}},clicks:{".statusbar":function(){this.params.statusbar.enabled&&this.params.statusbar.scrollTopOnClick&&Statusbar.onClick.call(this)}}};function getCurrentView(e){var t=$(".popover.modal-in .view"),a=$(".popup.modal-in .view"),r=$(".panel.panel-active .view"),i=$(".views");0===i.length&&(i=e.root);var n=i.children(".view");if(n.length>1&&n.hasClass("tab")&&(n=i.children(".view.tab-active")),t.length>0&&t[0].f7View)return t[0].f7View;if(a.length>0&&a[0].f7View)return a[0].f7View;if(r.length>0&&r[0].f7View)return r[0].f7View;if(n.length>0){if(1===n.length&&n[0].f7View)return n[0].f7View;if(n.length>1)return e.views.main}}var View$1={name:"view",params:{view:{name:void 0,main:!1,router:!0,linksView:null,stackPages:!1,xhrCache:!0,xhrCacheIgnore:[],xhrCacheIgnoreGetParameters:!1,xhrCacheDuration:6e5,preloadPreviousPage:!0,allowDuplicateUrls:!1,reloadPages:!1,reloadDetail:!1,masterDetailBreakpoint:0,removeElements:!0,removeElementsWithTimeout:!1,removeElementsTimeout:0,restoreScrollTopOnBack:!0,unloadTabContent:!0,passRouteQueryToRequest:!0,passRouteParamsToRequest:!1,iosSwipeBack:!0,iosSwipeBackAnimateShadow:!0,iosSwipeBackAnimateOpacity:!0,iosSwipeBackActiveArea:30,iosSwipeBackThreshold:0,mdSwipeBack:!1,mdSwipeBackAnimateShadow:!0,mdSwipeBackAnimateOpacity:!1,mdSwipeBackActiveArea:30,mdSwipeBackThreshold:0,auroraSwipeBack:!1,auroraSwipeBackAnimateShadow:!1,auroraSwipeBackAnimateOpacity:!0,auroraSwipeBackActiveArea:30,auroraSwipeBackThreshold:0,pushState:!1,pushStateRoot:void 0,pushStateAnimate:!0,pushStateAnimateOnLoad:!1,pushStateSeparator:"#!",pushStateOnLoad:!0,animate:!0,iosDynamicNavbar:!0,iosSeparateDynamicNavbar:!0,iosAnimateNavbarBackIcon:!0,iosPageLoadDelay:0,mdPageLoadDelay:0,auroraPageLoadDelay:0,routesBeforeEnter:null,routesBeforeLeave:null}},static:{View:View},create:function(){var e=this;Utils.extend(e,{views:Utils.extend([],{create:function(t,a){return new View(e,t,a)},get:function(e){var t=$(e);if(t.length&&t[0].f7View)return t[0].f7View}})}),Object.defineProperty(e.views,"current",{enumerable:!0,configurable:!0,get:function(){return getCurrentView(e)}}),e.view=e.views},on:{init:function(){var e=this;$(".view-init").each(function(t,a){if(!a.f7View){var r=$(a).dataset();e.views.create(a,r)}})},modalOpen:function(e){var t=this;e.$el.find(".view-init").each(function(e,a){if(!a.f7View){var r=$(a).dataset();t.views.create(a,r)}})},modalBeforeDestroy:function(e){e&&e.$el&&e.$el.find(".view-init").each(function(e,t){var a=t.f7View;a&&a.destroy()})}}},Navbar={size:function(e){var t=this;if("ios"===t.theme||t.params.navbar[t.theme+"CenterTitle"]){var a=$(e);if(a.hasClass("navbar"))a=a.children(".navbar-inner").each(function(e,a){t.navbar.size(a)});else if(!(a.hasClass("stacked")||a.parents(".stacked").length>0||a.parents(".tab:not(.tab-active)").length>0||a.parents(".popup:not(.modal-in)").length>0)){"ios"!==t.theme&&t.params.navbar[t.theme+"CenterTitle"]&&a.addClass("navbar-inner-centered-title"),"ios"!==t.theme||t.params.navbar.iosCenterTitle||a.addClass("navbar-inner-left-title");var r,i,n,s,o=a.parents(".view").eq(0),l=t.rtl?a.children(".right"):a.children(".left"),p=t.rtl?a.children(".left"):a.children(".right"),c=a.children(".title"),d=a.children(".subnavbar"),u=0===l.length,h=0===p.length,f=u?0:l.outerWidth(!0),v=h?0:p.outerWidth(!0),m=c.outerWidth(!0),g=a.styles(),b=a[0].offsetWidth,y=b-parseInt(g.paddingLeft,10)-parseInt(g.paddingRight,10),w=a.hasClass("navbar-previous"),C=a.hasClass("sliding"),x=0,k=0;o.length>0&&o[0].f7View&&(i=(r=o[0].f7View.router)&&r.dynamicNavbar,r&&r.separateNavbar||(x=b,k=b/5)),h&&(n=y-m),u&&(n=0),u||h||(n=(y-v-m+f)/2);var E=(y-m)/2;y-f-v>m?(E<f&&(E=f),E+m>y-v&&(E=y-v-m),s=E-n):s=0;var S=t.rtl?-1:1;if(i&&"ios"===t.theme){if(c.hasClass("sliding")||c.length>0&&C){var T=-(n+s)*S+k,M=(y-n-s-m)*S-x;if(w&&r&&r.params.iosAnimateNavbarBackIcon){var P=a.parent().find(".navbar-current").children(".left.sliding").find(".back .icon ~ span");P.length>0&&(T+=P[0].offsetLeft)}c[0].f7NavbarLeftOffset=T,c[0].f7NavbarRightOffset=M}if(!u&&(l.hasClass("sliding")||C))if(t.rtl)l[0].f7NavbarLeftOffset=-(y-l[0].offsetWidth)/2*S,l[0].f7NavbarRightOffset=f*S;else if(l[0].f7NavbarLeftOffset=-f+k,l[0].f7NavbarRightOffset=(y-l[0].offsetWidth)/2-x,r&&r.params.iosAnimateNavbarBackIcon&&l.find(".back .icon").length>0&&l.find(".back .icon ~ span").length){var O=l[0].f7NavbarLeftOffset,D=l[0].f7NavbarRightOffset;l[0].f7NavbarLeftOffset=0,l[0].f7NavbarRightOffset=0,l.find(".back .icon ~ span")[0].f7NavbarLeftOffset=O,l.find(".back .icon ~ span")[0].f7NavbarRightOffset=D-l.find(".back .icon")[0].offsetWidth}h||!p.hasClass("sliding")&&!C||(t.rtl?(p[0].f7NavbarLeftOffset=-v*S,p[0].f7NavbarRightOffset=(y-p[0].offsetWidth)/2*S):(p[0].f7NavbarLeftOffset=-(y-p[0].offsetWidth)/2+k,p[0].f7NavbarRightOffset=v-x)),d.length&&(d.hasClass("sliding")||C)&&(d[0].f7NavbarLeftOffset=t.rtl?d[0].offsetWidth:-d[0].offsetWidth+k,d[0].f7NavbarRightOffset=-d[0].f7NavbarLeftOffset-x+k)}if(t.params.navbar[t.theme+"CenterTitle"]){var I=s;t.rtl&&u&&h&&c.length>0&&(I=-I),c.css({left:I+"px"})}}}},hide:function(e,t){void 0===t&&(t=!0);var a=$(e);if(a.hasClass("navbar-inner")&&(a=a.parents(".navbar")),a.length&&!a.hasClass("navbar-hidden")){var r="navbar-hidden"+(t?" navbar-transitioning":"");("ios"===this.theme?a.find(".navbar-current .title-large").length:a.find(".title-large").length)&&(r+=" navbar-large-hidden"),a.transitionEnd(function(){a.removeClass("navbar-transitioning")}),a.addClass(r),a.trigger("navbar:hide"),this.emit("navbarHide",a[0])}},show:function(e,t){void 0===e&&(e=".navbar-hidden"),void 0===t&&(t=!0);var a=$(e);a.hasClass("navbar-inner")&&(a=a.parents(".navbar")),a.length&&a.hasClass("navbar-hidden")&&(t&&(a.addClass("navbar-transitioning"),a.transitionEnd(function(){a.removeClass("navbar-transitioning")})),a.removeClass("navbar-hidden navbar-large-hidden"),a.trigger("navbar:show"),this.emit("navbarShow",a[0]))},getElByPage:function(e){var t,a,r;if(e.$navbarEl||e.$el?(r=e,t=e.$el):(t=$(e)).length>0&&(r=t[0].f7Page),r&&r.$navbarEl&&r.$navbarEl.length>0?a=r.$navbarEl:t&&(a=t.children(".navbar").children(".navbar-inner")),a&&(!a||0!==a.length))return a[0]},getPageByEl:function(e){var t,a=$(e);if(!(a.hasClass("navbar")&&(a=a.find(".navbar-inner")).length>1))return a.parents(".page").length?a.parents(".page")[0]:(a.parents(".view").find(".page").each(function(e,r){r&&r.f7Page&&r.f7Page.navbarEl&&a[0]===r.f7Page.navbarEl&&(t=r)}),t)},collapseLargeTitle:function(e){var t=$(e);if(!(t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length))){var a=$(this.navbar.getPageByEl(t));t.addClass("navbar-inner-large-collapsed"),a.eq(0).addClass("page-with-navbar-large-collapsed").trigger("page:navbarlargecollapsed"),this.emit("pageNavbarLargeCollapsed",a[0]);var r=t.parents(".navbar");"md"!==this.theme&&"aurora"!==this.theme||r.addClass("navbar-large-collapsed"),r.trigger("navbar:collapse"),this.emit("navbarCollapse",r[0])}},expandLargeTitle:function(e){var t=$(e);if(!(t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length))){var a=$(this.navbar.getPageByEl(t));t.removeClass("navbar-inner-large-collapsed"),a.eq(0).removeClass("page-with-navbar-large-collapsed").trigger("page:navbarlargeexpanded"),this.emit("pageNavbarLargeExpanded",a[0]);var r=t.parents(".navbar");"md"!==this.theme&&"aurora"!==this.theme||r.removeClass("navbar-large-collapsed"),r.trigger("navbar:expand"),this.emit("navbarExpand",r[0])}},toggleLargeTitle:function(e){var t=$(e);t.hasClass("navbar")&&((t=t.find(".navbar-inner-large")).length>1&&(t=$(e).find(".navbar-inner-large.navbar-current")),t.length>1||!t.length)||(t.hasClass("navbar-inner-large-collapsed")?this.navbar.expandLargeTitle(t):this.navbar.collapseLargeTitle(t))},initNavbarOnScroll:function(e,t,a,r){var i,n,s,o,l,p,c,d,u,h,f,v,m,g=this,b=$(e),y=$(t),w="md"===g.theme||"aurora"===g.theme?y.parents(".navbar"):$(t||g.navbar.getElByPage(e)).closest(".navbar"),C=y.find(".title-large").length||y.hasClass(".navbar-inner-large"),x=44,k=g.params.navbar.snapPageScrollToLargeTitle;(r||a&&C)&&((u=y.css("--f7-navbar-large-title-height"))&&u.indexOf("px")>=0?(u=parseInt(u,10),Number.isNaN(u)&&("ios"===g.theme?u=52:"md"===g.theme?u=48:"aurora"===g.theme&&(u=38))):"ios"===g.theme?u=52:"md"===g.theme?u=48:"aurora"===g.theme&&(u=38)),a&&C&&(x+=u);var E=70,S=300;function T(){y.hasClass("with-searchbar-expandable-enabled")||!f||n<0||(n>=u/2&&n<u?$(f).scrollTop(u,100):n<u&&$(f).scrollTop(0,200))}function M(e){var t;(f=this,e&&e.target&&e.target!==f)||(n=f.scrollTop,h=n,r&&(t=Math.min(Math.max(n/u,0),1),y.hasClass("with-searchbar-expandable-enabled")||(d=y.hasClass("navbar-inner-large-collapsed"),0===t&&d?(g.navbar.expandLargeTitle(y[0]),y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="","md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")):1!==t||d?1===t&&d||0===t&&!d?(y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="",b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")):(y[0].style.setProperty("--f7-navbar-large-collapse-progress",t),y[0].style.overflow="visible",b[0].style.setProperty("--f7-navbar-large-collapse-progress",t),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.setProperty("--f7-navbar-large-collapse-progress",t)):(g.navbar.collapseLargeTitle(y[0]),y[0].style.removeProperty("--f7-navbar-large-collapse-progress"),y[0].style.overflow="",b[0].style.removeProperty("--f7-navbar-large-collapse-progress"),"md"!==g.theme&&"aurora"!==g.theme||w[0].style.removeProperty("--f7-navbar-large-collapse-progress")),k&&(Support.touch?m&&(clearTimeout(m),m=null,m=setTimeout(function(){T(),clearTimeout(m),m=null},E)):(clearTimeout(v),v=setTimeout(function(){T()},S))))),b.hasClass("page-previous")||a&&(s=f.scrollHeight,o=f.offsetHeight,l=n+o>=s,c=w.hasClass("navbar-hidden"),l?g.params.navbar.showOnPageScrollEnd&&(p="show"):p=i>n?g.params.navbar.showOnPageScrollTop||n<=x?"show":"hide":n>x?"hide":"show","show"===p&&c?(g.navbar.show(w),c=!1):"hide"!==p||c||(g.navbar.hide(w),c=!0),i=n))}function P(){h=!1}function O(){clearTimeout(m),m=null,m=setTimeout(function(){!1!==h&&(T(),clearTimeout(m),m=null)},E)}b.on("scroll",".page-content",M,!0),Support.touch&&r&&k&&(g.on("touchstart:passive",P),g.on("touchend:passive",O)),r&&b.find(".page-content").each(function(e,t){t.scrollTop>0&&M.call(t)}),b[0].f7DetachNavbarScrollHandlers=function(){delete b[0].f7DetachNavbarScrollHandlers,b.off("scroll",".page-content",M,!0),Support.touch&&r&&k&&(g.off("touchstart:passive",P),g.off("touchend:passive",O))}}},Navbar$1={name:"navbar",create:function(){var e=this;Utils.extend(e,{navbar:{size:Navbar.size.bind(e),hide:Navbar.hide.bind(e),show:Navbar.show.bind(e),getElByPage:Navbar.getElByPage.bind(e),getPageByEl:Navbar.getPageByEl.bind(e),collapseLargeTitle:Navbar.collapseLargeTitle.bind(e),expandLargeTitle:Navbar.expandLargeTitle.bind(e),toggleLargeTitle:Navbar.toggleLargeTitle.bind(e),initNavbarOnScroll:Navbar.initNavbarOnScroll.bind(e)}})},params:{navbar:{scrollTopOnTitleClick:!0,iosCenterTitle:!0,mdCenterTitle:!1,auroraCenterTitle:!0,hideOnPageScroll:!1,showOnPageScrollEnd:!0,showOnPageScrollTop:!0,collapseLargeTitleOnScroll:!0,snapPageScrollToLargeTitle:!0}},on:{"panelBreakpoint panelResize resize viewMasterDetailBreakpoint":function(){var e=this;$(".navbar").each(function(t,a){e.navbar.size(a)})},pageBeforeRemove:function(e){e.$el[0].f7DetachNavbarScrollHandlers&&e.$el[0].f7DetachNavbarScrollHandlers()},pageBeforeIn:function(e){if("ios"===this.theme){var t,a=e.$el.parents(".view")[0].f7View,r=this.navbar.getElByPage(e);if(t=r?$(r).parents(".navbar"):e.$el.parents(".view").children(".navbar"),e.$el.hasClass("no-navbar")||a.router.dynamicNavbar&&!r){var i=!!(e.pageFrom&&e.router.history.length>0);this.navbar.hide(t,i)}else this.navbar.show(t)}},pageReinit:function(e){var t=$(this.navbar.getElByPage(e));t&&0!==t.length&&this.navbar.size(t)},pageInit:function(e){var t,a,r=$(this.navbar.getElByPage(e));r&&0!==r.length&&(this.navbar.size(r),r.children(".title-large").length>0&&r.addClass("navbar-inner-large"),r.hasClass("navbar-inner-large")&&(this.params.navbar.collapseLargeTitleOnScroll&&(t=!0),"md"!==this.theme&&"aurora"!==this.theme||r.parents(".navbar").addClass("navbar-large"),e.$el.addClass("page-with-navbar-large")),(this.params.navbar.hideOnPageScroll||e.$el.find(".hide-navbar-on-scroll").length||e.$el.hasClass("hide-navbar-on-scroll")||e.$el.find(".hide-bars-on-scroll").length||e.$el.hasClass("hide-bars-on-scroll"))&&(a=!(e.$el.find(".keep-navbar-on-scroll").length||e.$el.hasClass("keep-navbar-on-scroll")||e.$el.find(".keep-bars-on-scroll").length||e.$el.hasClass("keep-bars-on-scroll"))),(t||a)&&this.navbar.initNavbarOnScroll(e.el,r[0],a,t))},modalOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},panelOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},panelSwipeOpen:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&e.$el.find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})},tabShow:function(e){var t=this;t.params.navbar[t.theme+"CenterTitle"]&&$(e).find(".navbar:not(.navbar-previous):not(.stacked)").each(function(e,a){t.navbar.size(a)})}},clicks:{".navbar .title":function(e){if(this.params.navbar.scrollTopOnTitleClick&&!(e.closest("a").length>0)){var t,a=e.parents(".navbar");0===(t=a.parents(".page-content")).length&&(a.parents(".page").length>0&&(t=a.parents(".page").find(".page-content")),0===t.length&&a.nextAll(".page-current:not(.stacked)").length>0&&(t=a.nextAll(".page-current:not(.stacked)").find(".page-content"))),t&&t.length>0&&(t.hasClass("tab")&&(t=t.parent(".tabs").children(".page-content.tab-active")),t.length>0&&t.scrollTop(0,300))}}},vnode:{"navbar-inner":{postpatch:function(e){this.params.navbar[this.theme+"CenterTitle"]&&this.navbar.size(e.elm)}}}},Toolbar={setHighlight:function(e){if("md"===this.theme){var t=$(e);if(0!==t.length&&(t.hasClass("tabbar")||t.hasClass("tabbar-labels"))){var a=t.find(".tab-link-highlight"),r=t.find(".tab-link").length;if(0!==r){0===a.length?(t.children(".toolbar-inner").append('<span class="tab-link-highlight"></span>'),a=t.find(".tab-link-highlight")):a.next().length&&t.children(".toolbar-inner").append(a);var i,n,s=t.find(".tab-link-active");if(t.hasClass("tabbar-scrollable")&&s&&s[0])i=s[0].offsetWidth+"px",n=s[0].offsetLeft+"px";else{var o=s.index();i=100/r+"%",n=100*(this.rtl?-o:o)+"%"}Utils.nextFrame(function(){a.css("width",i).transform("translate3d("+n+",0,0)")})}else a.remove()}}},init:function(e){this.toolbar.setHighlight(e)},hide:function(e,t){void 0===t&&(t=!0);var a=$(e);if(!a.hasClass("toolbar-hidden")){var r="toolbar-hidden"+(t?" toolbar-transitioning":"");a.transitionEnd(function(){a.removeClass("toolbar-transitioning")}),a.addClass(r)}},show:function(e,t){void 0===t&&(t=!0);var a=$(e);a.hasClass("toolbar-hidden")&&(t&&(a.addClass("toolbar-transitioning"),a.transitionEnd(function(){a.removeClass("toolbar-transitioning")})),a.removeClass("toolbar-hidden"))},initHideToolbarOnScroll:function(e){var t,a,r,i,n,s,o,l=this,p=$(e),c=p.parents(".view").children(".toolbar");(0===c.length&&(c=p.find(".toolbar")),0===c.length&&(c=p.parents(".views").children(".tabbar, .tabbar-labels")),0!==c.length)&&(p.on("scroll",".page-content",d,!0),p[0].f7ScrollToolbarHandler=d);function d(e){e&&e.target&&e.target!==this||p.hasClass("page-previous")||(a=this.scrollTop,r=this.scrollHeight,i=this.offsetHeight,n=a+i>=r,o=c.hasClass("toolbar-hidden"),n?l.params.toolbar.showOnPageScrollEnd&&(s="show"):s=t>a?l.params.toolbar.showOnPageScrollTop||a<=44?"show":"hide":a>44?"hide":"show","show"===s&&o?(l.toolbar.show(c),o=!1):"hide"!==s||o||(l.toolbar.hide(c),o=!0),t=a)}}},Toolbar$1={name:"toolbar",create:function(){Utils.extend(this,{toolbar:{hide:Toolbar.hide.bind(this),show:Toolbar.show.bind(this),setHighlight:Toolbar.setHighlight.bind(this),initHideToolbarOnScroll:Toolbar.initHideToolbarOnScroll.bind(this),init:Toolbar.init.bind(this)}})},params:{toolbar:{hideOnPageScroll:!1,showOnPageScrollEnd:!0,showOnPageScrollTop:!0}},on:{pageBeforeRemove:function(e){e.$el[0].f7ScrollToolbarHandler&&e.$el.off("scroll",".page-content",e.$el[0].f7ScrollToolbarHandler,!0)},pageBeforeIn:function(e){var t=e.$el.parents(".view").children(".toolbar");0===t.length&&(t=e.$el.parents(".views").children(".tabbar, .tabbar-labels")),0===t.length&&(t=e.$el.find(".toolbar")),0!==t.length&&(e.$el.hasClass("no-toolbar")?this.toolbar.hide(t):this.toolbar.show(t))},pageInit:function(e){var t=this;if(e.$el.find(".tabbar, .tabbar-labels").each(function(e,a){t.toolbar.init(a)}),t.params.toolbar.hideOnPageScroll||e.$el.find(".hide-toolbar-on-scroll").length||e.$el.hasClass("hide-toolbar-on-scroll")||e.$el.find(".hide-bars-on-scroll").length||e.$el.hasClass("hide-bars-on-scroll")){if(e.$el.find(".keep-toolbar-on-scroll").length||e.$el.hasClass("keep-toolbar-on-scroll")||e.$el.find(".keep-bars-on-scroll").length||e.$el.hasClass("keep-bars-on-scroll"))return;t.toolbar.initHideToolbarOnScroll(e.el)}},init:function(){var e=this;e.root.find(".tabbar, .tabbar-labels").each(function(t,a){e.toolbar.init(a)})}}},Subnavbar={name:"subnavbar",on:{pageInit:function(e){e.$navbarEl&&e.$navbarEl.length&&e.$navbarEl.find(".subnavbar").length&&e.$el.addClass("page-with-subnavbar"),e.$el.find(".subnavbar").length&&e.$el.addClass("page-with-subnavbar")}}},TouchRipple=function(e,t,a){var r=this;if(e){var i=e[0].getBoundingClientRect(),n=t-i.left,s=a-i.top,o=i.width,l=i.height,p=Math.max(Math.pow(Math.pow(l,2)+Math.pow(o,2),.5),48);return r.$rippleWaveEl=$('<div class="ripple-wave" style="width: '+p+"px; height: "+p+"px; margin-top:-"+p/2+"px; margin-left:-"+p/2+"px; left:"+n+"px; top:"+s+'px;"></div>'),e.prepend(r.$rippleWaveEl),r.rippleTransform="translate3d("+(o/2-n)+"px, "+(l/2-s)+"px, 0) scale(1)",Utils.nextFrame(function(){r&&r.$rippleWaveEl&&r.$rippleWaveEl.transform(r.rippleTransform)}),r}};TouchRipple.prototype.destroy=function(){var e=this;e.$rippleWaveEl&&e.$rippleWaveEl.remove(),Object.keys(e).forEach(function(t){e[t]=null,delete e[t]}),e=null},TouchRipple.prototype.remove=function(){var e=this;if(!e.removing){var t=this.$rippleWaveEl,a=this.rippleTransform,r=Utils.nextTick(function(){e.destroy()},400);e.removing=!0,t.addClass("ripple-wave-fill").transform(a.replace("scale(1)","scale(1.01)")).transitionEnd(function(){clearTimeout(r),Utils.nextFrame(function(){t.addClass("ripple-wave-out").transform(a.replace("scale(1)","scale(1.01)")),r=Utils.nextTick(function(){e.destroy()},700),t.transitionEnd(function(){clearTimeout(r),e.destroy()})})})}};var TouchRipple$1={name:"touch-ripple",static:{TouchRipple:TouchRipple},create:function(){this.touchRipple={create:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];return new(Function.prototype.bind.apply(TouchRipple,[null].concat(e)))}}}},openedModals=[],dialogsQueue=[];function clearDialogsQueue(){0!==dialogsQueue.length&&dialogsQueue.shift().open()}var Modal=function(e){function t(t,a){e.call(this,a,[t]);var r={};return this.useModulesParams(r),this.params=Utils.extend(r,a),this.opened=!1,this.useModules(),this}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.onOpen=function(){this.opened=!0,openedModals.push(this),$("html").addClass("with-modal-"+this.type.toLowerCase()),this.$el.trigger("modal:open "+this.type.toLowerCase()+":open",this),this.emit("local::open modalOpen "+this.type+"Open",this)},t.prototype.onOpened=function(){this.$el.trigger("modal:opened "+this.type.toLowerCase()+":opened",this),this.emit("local::opened modalOpened "+this.type+"Opened",this)},t.prototype.onClose=function(){this.opened=!1,this.type&&this.$el&&(openedModals.splice(openedModals.indexOf(this),1),$("html").removeClass("with-modal-"+this.type.toLowerCase()),this.$el.trigger("modal:close "+this.type.toLowerCase()+":close",this),this.emit("local::close modalClose "+this.type+"Close",this))},t.prototype.onClosed=function(){this.type&&this.$el&&(this.$el.removeClass("modal-out"),this.$el.hide(),this.$el.trigger("modal:closed "+this.type.toLowerCase()+":closed",this),this.emit("local::closed modalClosed "+this.type+"Closed",this))},t.prototype.open=function(e){var t,a=this,r=a.app,i=a.$el,n=a.$backdropEl,s=a.type,o=!0;if(void 0!==e?o=e:void 0!==a.params.animate&&(o=a.params.animate),!i||i.hasClass("modal-in"))return a;if("dialog"===s&&r.params.modal.queueDialogs&&($(".dialog.modal-in").length>0?t=!0:openedModals.length>0&&openedModals.forEach(function(e){"dialog"===e.type&&(t=!0)}),t))return dialogsQueue.push(a),a;var l=i.parent(),p=i.parents(doc).length>0;function c(){i.hasClass("modal-out")?a.onClosed():i.hasClass("modal-in")&&a.onOpened()}return r.params.modal.moveToRoot&&!l.is(r.root)&&(r.root.append(i),a.once(s+"Closed",function(){p?l.append(i):i.remove()})),i.show(),a._clientLeft=i[0].clientLeft,o?(n&&(n.removeClass("not-animated"),n.addClass("backdrop-in")),i.animationEnd(function(){c()}),i.transitionEnd(function(){c()}),i.removeClass("modal-out not-animated").addClass("modal-in"),a.onOpen()):(n&&n.addClass("backdrop-in not-animated"),i.removeClass("modal-out").addClass("modal-in not-animated"),a.onOpen(),a.onOpened()),a},t.prototype.close=function(e){var t=this,a=t.$el,r=t.$backdropEl,i=!0;if(void 0!==e?i=e:void 0!==t.params.animate&&(i=t.params.animate),!a||!a.hasClass("modal-in"))return dialogsQueue.indexOf(t)>=0&&dialogsQueue.splice(dialogsQueue.indexOf(t),1),t;if(r){var n=!0;"popup"===t.type&&t.$el.prevAll(".popup.modal-in").each(function(e,a){var r=a.f7Modal;r&&r.params.closeByBackdropClick&&r.params.backdrop&&r.backdropEl===t.backdropEl&&(n=!1)}),n&&(r[i?"removeClass":"addClass"]("not-animated"),r.removeClass("backdrop-in"))}function s(){a.hasClass("modal-out")?t.onClosed():a.hasClass("modal-in")&&t.onOpened()}return a[i?"removeClass":"addClass"]("not-animated"),i?(a.animationEnd(function(){s()}),a.transitionEnd(function(){s()}),a.removeClass("modal-in").addClass("modal-out"),t.onClose()):(a.addClass("not-animated").removeClass("modal-in").addClass("modal-out"),t.onClose(),t.onClosed()),"dialog"===t.type&&clearDialogsQueue(),t},t.prototype.destroy=function(){this.destroyed||(this.emit("local::beforeDestroy modalBeforeDestroy "+this.type+"BeforeDestroy",this),this.$el&&(this.$el.trigger("modal:beforedestroy "+this.type.toLowerCase()+":beforedestroy",this),this.$el.length&&this.$el[0].f7Modal&&delete this.$el[0].f7Modal),Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),CustomModal=function(e){function t(t,a){var r=Utils.extend({backdrop:!0,closeByBackdropClick:!0,on:{}},a);e.call(this,t,r);var i,n,s=this;if(s.params=r,(i=s.params.el?$(s.params.el):$(s.params.content))&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(0===i.length)return s.destroy();function o(e){s&&!s.destroyed&&n&&e.target===n[0]&&s.close()}return s.params.backdrop&&0===(n=t.root.children(".custom-modal-backdrop")).length&&(n=$('<div class="custom-modal-backdrop"></div>'),t.root.append(n)),s.on("customModalOpened",function(){s.params.closeByBackdropClick&&s.params.backdrop&&t.on("click",o)}),s.on("customModalClose",function(){s.params.closeByBackdropClick&&s.params.backdrop&&t.off("click",o)}),Utils.extend(s,{app:t,$el:i,el:i[0],$backdropEl:n,backdropEl:n&&n[0],type:"customModal"}),i[0].f7Modal=s,s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Modal$1={name:"modal",static:{Modal:Modal,CustomModal:CustomModal},create:function(){var e=this;e.customModal={create:function(t){return new CustomModal(e,t)}}},params:{modal:{moveToRoot:!0,queueDialogs:!0}}},Appbar={name:"appbar"},Dialog=function(e){function t(t,a){var r=Utils.extend({title:t.params.dialog.title,text:void 0,content:"",buttons:[],verticalButtons:!1,onClick:void 0,cssClass:void 0,destroyOnClose:!1,on:{}},a);void 0===r.closeByBackdropClick&&(r.closeByBackdropClick=t.params.dialog.closeByBackdropClick),e.call(this,t,r);var i,n=this,s=r.title,o=r.text,l=r.content,p=r.buttons,c=r.verticalButtons,d=r.cssClass;if(n.params=r,n.params.el)i=$(n.params.el);else{var u=["dialog"];0===p.length&&u.push("dialog-no-buttons"),p.length>0&&u.push("dialog-buttons-"+p.length),c&&u.push("dialog-buttons-vertical"),d&&u.push(d);var h="";p.length>0&&(h='\n          <div class="dialog-buttons">\n            '+p.map(function(e){return'\n              <span class="dialog-button'+(e.bold?" dialog-button-bold":"")+(e.color?" color-"+e.color:"")+(e.cssClass?" "+e.cssClass:"")+'">'+e.text+"</span>\n            "}).join("")+"\n          </div>\n        ");var f='\n        <div class="'+u.join(" ")+'">\n          <div class="dialog-inner">\n            '+(s?'<div class="dialog-title">'+s+"</div>":"")+"\n            "+(o?'<div class="dialog-text">'+o+"</div>":"")+"\n            "+l+"\n          </div>\n          "+h+"\n        </div>\n      ";i=$(f)}if(i&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(0===i.length)return n.destroy();var v,m=t.root.children(".dialog-backdrop");function g(e){var t=$(this).index(),a=p[t];a.onClick&&a.onClick(n,e),n.params.onClick&&n.params.onClick(n,t),!1!==a.close&&n.close()}function b(e){var t=e.keyCode;p.forEach(function(a,r){a.keyCodes&&a.keyCodes.indexOf(t)>=0&&(doc.activeElement&&doc.activeElement.blur(),a.onClick&&a.onClick(n,e),n.params.onClick&&n.params.onClick(n,r),!1!==a.close&&n.close())})}function y(e){var t=e.target;0===$(t).closest(n.el).length&&n.params.closeByBackdropClick&&n.backdropEl&&n.backdropEl===t&&n.close()}return 0===m.length&&(m=$('<div class="dialog-backdrop"></div>'),t.root.append(m)),p&&p.length>0&&(n.on("open",function(){i.find(".dialog-button").each(function(e,t){p[e].keyCodes&&(v=!0),$(t).on("click",g)}),!v||t.device.ios||t.device.android||t.device.cordova||$(doc).on("keydown",b)}),n.on("close",function(){i.find(".dialog-button").each(function(e,t){$(t).off("click",g)}),!v||t.device.ios||t.device.android||t.device.cordova||$(doc).off("keydown",b),v=!1})),Utils.extend(n,{app:t,$el:i,el:i[0],$backdropEl:m,backdropEl:m[0],type:"dialog",setProgress:function(e,a){return t.progressbar.set(i.find(".progressbar"),e,a),n},setText:function(e){var t=i.find(".dialog-text");return 0===t.length&&(t=$('<div class="dialog-text"></div>'),void 0!==s?t.insertAfter(i.find(".dialog-title")):i.find(".dialog-inner").prepend(t)),t.html(e),n.params.text=e,n},setTitle:function(e){var t=i.find(".dialog-title");return 0===t.length&&(t=$('<div class="dialog-title"></div>'),i.find(".dialog-inner").prepend(t)),t.html(e),n.params.title=e,n}}),n.on("opened",function(){n.params.closeByBackdropClick&&t.on("click",y)}),n.on("close",function(){n.params.closeByBackdropClick&&t.off("click",y)}),i[0].f7Modal=n,n.params.destroyOnClose&&n.once("closed",function(){setTimeout(function(){n.destroy()},0)}),n}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Dialog$1={name:"dialog",params:{dialog:{title:void 0,buttonOk:"OK",buttonCancel:"Cancel",usernamePlaceholder:"Username",passwordPlaceholder:"Password",preloaderTitle:"Loading... ",progressTitle:"Loading... ",closeByBackdropClick:!1,destroyPredefinedDialogs:!0,keyboardActions:!0}},static:{Dialog:Dialog},create:function(){var e=this;function t(){return e.params.dialog.title||e.name}var a=e.params.dialog.destroyPredefinedDialogs,r=e.params.dialog.keyboardActions;e.dialog=Utils.extend(ModalMethods({app:e,constructor:Dialog,defaultSelector:".dialog.modal-in"}),{alert:function(){for(var i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2];return 2===n.length&&"function"==typeof n[1]&&(o=(i=n)[0],p=i[1],l=i[2]),new Dialog(e,{title:void 0===l?t():l,text:o,buttons:[{text:e.params.dialog.buttonOk,bold:!0,onClick:p,keyCodes:r?[13,27]:null}],destroyOnClose:a}).open()},prompt:function(){for(var i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2],c=n[3],d=n[4];return"function"==typeof n[1]&&(o=(i=n)[0],p=i[1],c=i[2],d=i[3],l=i[4]),d=null==d?"":d,new Dialog(e,{title:void 0===l?t():l,text:o,content:'<div class="dialog-input-field input"><input type="text" class="dialog-input" value="'+d+'"></div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find(".dialog-input").val();0===t&&c&&c(a),1===t&&p&&p(a)},destroyOnClose:a}).open()},confirm:function(){for(var i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2],c=n[3];return"function"==typeof n[1]&&(o=(i=n)[0],p=i[1],c=i[2],l=i[3]),new Dialog(e,{title:void 0===l?t():l,text:o,buttons:[{text:e.params.dialog.buttonCancel,onClick:c,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,onClick:p,keyCodes:r?[13]:null}],destroyOnClose:a}).open()},login:function(){for(var i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2],c=n[3];return"function"==typeof n[1]&&(o=(i=n)[0],p=i[1],c=i[2],l=i[3]),new Dialog(e,{title:void 0===l?t():l,text:o,content:'\n              <div class="dialog-input-field dialog-input-double input">\n                <input type="text" name="dialog-username" placeholder="'+e.params.dialog.usernamePlaceholder+'" class="dialog-input">\n              </div>\n              <div class="dialog-input-field dialog-input-double input">\n                <input type="password" name="dialog-password" placeholder="'+e.params.dialog.passwordPlaceholder+'" class="dialog-input">\n              </div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find('[name="dialog-username"]').val(),r=e.$el.find('[name="dialog-password"]').val();0===t&&c&&c(a,r),1===t&&p&&p(a,r)},destroyOnClose:a}).open()},password:function(){for(var i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2],c=n[3];return"function"==typeof n[1]&&(o=(i=n)[0],p=i[1],c=i[2],l=i[3]),new Dialog(e,{title:void 0===l?t():l,text:o,content:'\n              <div class="dialog-input-field input">\n                <input type="password" name="dialog-password" placeholder="'+e.params.dialog.passwordPlaceholder+'" class="dialog-input">\n              </div>',buttons:[{text:e.params.dialog.buttonCancel,keyCodes:r?[27]:null,color:"aurora"===e.theme?"gray":null},{text:e.params.dialog.buttonOk,bold:!0,keyCodes:r?[13]:null}],onClick:function(e,t){var a=e.$el.find('[name="dialog-password"]').val();0===t&&c&&c(a),1===t&&p&&p(a)},destroyOnClose:a}).open()},preloader:function(t,r){var i=Utils[e.theme+"PreloaderContent"]||"";return new Dialog(e,{title:null==t?e.params.dialog.preloaderTitle:t,content:'<div class="preloader'+(r?" color-"+r:"")+'">'+i+"</div>",cssClass:"dialog-preloader",destroyOnClose:a}).open()},progress:function(){for(var t,r,i,n=[],s=arguments.length;s--;)n[s]=arguments[s];var o=n[0],l=n[1],p=n[2];2===n.length?"number"==typeof n[0]?(l=(t=n)[0],p=t[1],o=t[2]):"string"==typeof n[0]&&"string"==typeof n[1]&&(o=(r=n)[0],p=r[1],l=r[2]):1===n.length&&"number"==typeof n[0]&&(l=(i=n)[0],o=i[1],p=i[2]);var c=void 0===l,d=new Dialog(e,{title:void 0===o?e.params.dialog.progressTitle:o,cssClass:"dialog-progress",content:'\n              <div class="progressbar'+(c?"-infinite":"")+(p?" color-"+p:"")+'">\n                '+(c?"":"<span></span>")+"\n              </div>\n            ",destroyOnClose:a});return c||d.setProgress(l),d.open()}})}},Popup=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.popup,a);e.call(this,t,r);var i,n,s=this;if(s.params=r,(i=s.params.el?$(s.params.el).eq(0):$(s.params.content).filter(function(e,t){return 1===t.nodeType}).eq(0))&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(0===i.length)return s.destroy();function o(e){var a=e.target,r=$(a);if(!(!t.device.desktop&&t.device.cordova&&(window.Keyboard&&window.Keyboard.isVisible||window.cordova.plugins&&window.cordova.plugins.Keyboard&&window.cordova.plugins.Keyboard.isVisible))&&0===r.closest(s.el).length&&s.params&&s.params.closeByBackdropClick&&s.params.backdrop&&s.backdropEl&&s.backdropEl===a){var i=!0;s.$el.nextAll(".popup.modal-in").each(function(e,t){var a=t.f7Modal;a&&a.params.closeByBackdropClick&&a.params.backdrop&&a.backdropEl===s.backdropEl&&(i=!1)}),i&&s.close()}}function l(e){27===e.keyCode&&s.params.closeOnEscape&&s.close()}s.params.backdrop&&s.params.backdropEl?n=$(s.params.backdropEl):s.params.backdrop&&0===(n=t.root.children(".popup-backdrop")).length&&(n=$('<div class="popup-backdrop"></div>'),t.root.append(n)),Utils.extend(s,{app:t,$el:i,el:i[0],$backdropEl:n,backdropEl:n&&n[0],type:"popup"}),s.params.closeOnEscape&&(s.on("popupOpen",function(){$(document).on("keydown",l)}),s.on("popupClose",function(){$(document).off("keydown",l)})),s.on("popupOpened",function(){i.removeClass("swipe-close-to-bottom swipe-close-to-top"),s.params.closeByBackdropClick&&t.on("click",o)}),s.on("popupClose",function(){s.params.closeByBackdropClick&&t.off("click",o)});var p,c,d,u,h,f,v,m,g,b=!0,y=!1,w=!1;function C(e){!y&&b&&s.params.swipeToClose&&(s.params.swipeHandler&&0===$(e.target).closest(s.params.swipeHandler).length||(y=!0,w=!1,p={x:"touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,y:"touchstart"===e.type?e.targetTouches[0].pageY:e.pageY},u=Utils.now(),d=void 0,s.params.swipeHandler||"touchstart"!==e.type||(f=$(e.target).closest(".page-content")[0])))}function x(e){if(y){if(c={x:"touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,y:"touchmove"===e.type?e.targetTouches[0].pageY:e.pageY},void 0===d&&(d=!!(d||Math.abs(c.x-p.x)>Math.abs(c.y-p.y))),d)return y=!1,void(w=!1);var t=(h=p.y-c.y)<0?"to-bottom":"to-top";if(i.transition(0),"string"!=typeof s.params.swipeToClose||t===s.params.swipeToClose){if(!w){if(f&&(v=f.scrollTop,g=f.scrollHeight,m=f.offsetHeight,!(g===m||"to-bottom"===t&&0===v||"to-top"===t&&v===g-m)))return i.transform(""),y=!1,void(w=!1);w=!0}e.preventDefault(),i.transition(0).transform("translate3d(0,"+-h+"px,0)")}else i.transform("")}}function k(){if(y=!1,w){w=!1,b=!1,i.transition("");var e=h<0?"to-bottom":"to-top";if("string"==typeof s.params.swipeToClose&&e!==s.params.swipeToClose)return i.transform(""),void(b=!0);var t=Math.abs(h),a=(new Date).getTime()-u;a<300&&t>20||a>=300&&t>100?Utils.nextTick(function(){"to-bottom"===e?i.addClass("swipe-close-to-bottom"):i.addClass("swipe-close-to-top"),i.transform(""),s.close(),b=!0}):(b=!0,i.transform(""))}}var E=!!Support.passiveListener&&{passive:!0};return s.params.swipeToClose&&(i.on(t.touchEvents.start,C,E),t.on("touchmove",x),t.on("touchend:passive",k),s.once("popupDestroy",function(){i.off(t.touchEvents.start,C,E),t.off("touchmove",x),t.off("touchend:passive",k)})),i[0].f7Modal=s,s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Popup$1={name:"popup",params:{popup:{backdrop:!0,backdropEl:void 0,closeByBackdropClick:!0,closeOnEscape:!1,swipeToClose:!1,swipeHandler:null}},static:{Popup:Popup},create:function(){this.popup=ModalMethods({app:this,constructor:Popup,defaultSelector:".popup.modal-in"})},clicks:{".popup-open":function(e,t){void 0===t&&(t={});this.popup.open(t.popup,t.animate)},".popup-close":function(e,t){void 0===t&&(t={});this.popup.close(t.popup,t.animate)}}},LoginScreen=function(e){function t(t,a){var r=Utils.extend({on:{}},a);e.call(this,t,r);var i;return this.params=r,(i=this.params.el?$(this.params.el).eq(0):$(this.params.content).filter(function(e,t){return 1===t.nodeType}).eq(0))&&i.length>0&&i[0].f7Modal?i[0].f7Modal:0===i.length?this.destroy():(Utils.extend(this,{app:t,$el:i,el:i[0],type:"loginScreen"}),i[0].f7Modal=this,this)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),LoginScreen$1={name:"loginScreen",static:{LoginScreen:LoginScreen},create:function(){this.loginScreen=ModalMethods({app:this,constructor:LoginScreen,defaultSelector:".login-screen.modal-in"})},clicks:{".login-screen-open":function(e,t){void 0===t&&(t={});this.loginScreen.open(t.loginScreen,t.animate)},".login-screen-close":function(e,t){void 0===t&&(t={});this.loginScreen.close(t.loginScreen,t.animate)}}},Popover=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.popover,a);e.call(this,t,r);var i,n=this;if(n.params=r,(i=n.params.el?$(n.params.el).eq(0):$(n.params.content).filter(function(e,t){return 1===t.nodeType}).eq(0))&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;var s,o,l=$(n.params.targetEl).eq(0);if(0===i.length)return n.destroy();n.params.backdrop&&n.params.backdropEl?s=$(n.params.backdropEl):n.params.backdrop&&0===(s=t.root.children(".popover-backdrop")).length&&(s=$('<div class="popover-backdrop"></div>'),t.root.append(s)),0===i.find(".popover-angle").length?(o=$('<div class="popover-angle"></div>'),i.prepend(o)):o=i.find(".popover-angle");var p=n.open;function c(){n.resize()}function d(e){var a=e.target,r=$(a);!t.device.desktop&&t.device.cordova&&(window.Keyboard&&window.Keyboard.isVisible||window.cordova.plugins&&window.cordova.plugins.Keyboard&&window.cordova.plugins.Keyboard.isVisible)||0===r.closest(n.el).length&&(n.params.closeByBackdropClick&&n.params.backdrop&&n.backdropEl&&n.backdropEl===a?n.close():n.params.closeByOutsideClick&&n.close())}function u(e){27===e.keyCode&&n.params.closeOnEscape&&n.close()}return Utils.extend(n,{app:t,$el:i,el:i[0],$targetEl:l,targetEl:l[0],$angleEl:o,angleEl:o[0],$backdropEl:s,backdropEl:s&&s[0],type:"popover",open:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1];return"boolean"==typeof t[0]&&(i=(e=t)[0],r=e[1]),r&&(n.$targetEl=$(r),n.targetEl=n.$targetEl[0]),p.call(n,i)}}),n.on("popoverOpen",function(){n.resize(),t.on("resize",c),$(window).on("keyboardDidShow keyboardDidHide",c),n.on("popoverClose popoverBeforeDestroy",function(){t.off("resize",c),$(window).off("keyboardDidShow keyboardDidHide",c)})}),n.params.closeOnEscape&&(n.on("popoverOpen",function(){$(document).on("keydown",u)}),n.on("popoverClose",function(){$(document).off("keydown",u)})),n.on("popoverOpened",function(){(n.params.closeByOutsideClick||n.params.closeByBackdropClick)&&t.on("click",d)}),n.on("popoverClose",function(){(n.params.closeByOutsideClick||n.params.closeByBackdropClick)&&t.off("click",d)}),i[0].f7Modal=n,n}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.resize=function(){var e=this.app,t=this.$el,a=this.$targetEl,r=this.$angleEl,i=this.params,n=i.targetX,s=i.targetY;t.css({left:"",top:""});var o,l,p,c,d,u,h=[t.width(),t.height()],f=h[0],v=h[1],m=0;"ios"===e.theme||"aurora"===e.theme?(r.removeClass("on-left on-right on-top on-bottom").css({left:"",top:""}),m=r.width()/2):t.removeClass("popover-on-left popover-on-right popover-on-top popover-on-bottom popover-on-middle").css({left:"",top:""});var g=parseInt($("html").css("--f7-safe-area-top"),10);if(Number.isNaN(g)&&(g=0),a&&a.length>0){p=a.outerWidth(),c=a.outerHeight();var b=a.offset();d=b.left-e.left,u=b.top-e.top;var y=a.parents(".page");y.length>0&&(u-=y[0].scrollTop)}else void 0!==n&&"undefined"!==s&&(d=n,u=s,p=this.params.targetWidth||0,c=this.params.targetHeight||0);var w,C=[0,0,0],x=C[0],k=C[1],E=C[2],S="md"===e.theme?"bottom":"top";"md"===e.theme?(v<e.height-u-c?(S="bottom",k=u+c):v<u-g?(k=u-v,S="top"):(S="middle",k=c/2+u-v/2),k=Math.max(8,Math.min(k,e.height-v-8)),d<e.width/2?(w="right",x="middle"===S?d+p:d):(w="left",x="middle"===S?d-f:d+p-f),x=Math.max(8,Math.min(x,e.width-f-8)),t.addClass("popover-on-"+S+" popover-on-"+w)):(v+m<u-g?k=u-v-m:v+m<e.height-u-c?(S="bottom",k=u+c+m):(S="middle",E=k=c/2+u-v/2,E-=k=Math.max(5,Math.min(k,e.height-v-5))),"top"===S||"bottom"===S?(E=x=p/2+d-f/2,x=Math.max(5,Math.min(x,e.width-f-5)),"top"===S&&r.addClass("on-bottom"),"bottom"===S&&r.addClass("on-top"),o=f/2-m+(E-=x),o=Math.max(Math.min(o,f-2*m-13),13),r.css({left:o+"px"})):"middle"===S&&(x=d-f-m,r.addClass("on-right"),(x<5||x+f>e.width)&&(x<5&&(x=d+p+m),x+f>e.width&&(x=e.width-f-5),r.removeClass("on-right").addClass("on-left")),l=v/2-m+E,l=Math.max(Math.min(l,v-2*m-13),13),r.css({top:l+"px"})));t.css({top:k+"px",left:x+"px"})},t}(Modal),Popover$1={name:"popover",params:{popover:{backdrop:!0,backdropEl:void 0,closeByBackdropClick:!0,closeByOutsideClick:!0,closeOnEscape:!1}},static:{Popover:Popover},create:function(){var e=this;e.popover=Utils.extend(ModalMethods({app:e,constructor:Popover,defaultSelector:".popover.modal-in"}),{open:function(t,a,r){var i=$(t),n=i[0].f7Modal;return n||(n=new Popover(e,{el:i,targetEl:a})),n.open(a,r)}})},clicks:{".popover-open":function(e,t){void 0===t&&(t={});this.popover.open(t.popover,e,t.animate)},".popover-close":function(e,t){void 0===t&&(t={});this.popover.close(t.popover,t.animate)}}},Actions=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.actions,a);e.call(this,t,r);var i,n,s,o=this;if(o.params=r,o.params.buttons&&(i=o.params.buttons,Array.isArray(i[0])||(i=[i])),o.groups=i,o.params.el?n=$(o.params.el).eq(0):o.params.content?n=$(o.params.content).filter(function(e,t){return 1===t.nodeType}).eq(0):o.params.buttons&&(o.params.convertToPopover&&(o.popoverHtml=o.renderPopover()),o.actionsHtml=o.render()),n&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(n&&0===n.length&&!o.actionsHtml&&!o.popoverHtml)return o.destroy();o.params.backdrop&&o.params.backdropEl?s=$(o.params.backdropEl):o.params.backdrop&&0===(s=t.root.children(".actions-backdrop")).length&&(s=$('<div class="actions-backdrop"></div>'),t.root.append(s));var l,p=o.open,c=o.close;function d(e){var t,a,r=$(this);if(r.hasClass("list-button")||r.hasClass("item-link")?(t=r.parents("li").index(),a=r.parents(".list").index()):(t=r.index(),a=r.parents(".actions-group").index()),void 0!==i){var n=i[a][t];n.onClick&&n.onClick(o,e),o.params.onClick&&o.params.onClick(o,e),!1!==n.close&&o.close()}}function u(e){var a=e.target,r=$(a);!t.device.desktop&&t.device.cordova&&(window.Keyboard&&window.Keyboard.isVisible||window.cordova.plugins&&window.cordova.plugins.Keyboard&&window.cordova.plugins.Keyboard.isVisible)||0===r.closest(o.el).length&&(o.params.closeByBackdropClick&&o.params.backdrop&&o.backdropEl&&o.backdropEl===a?o.close():o.params.closeByOutsideClick&&o.close())}function h(e){27===e.keyCode&&o.params.closeOnEscape&&o.close()}return o.open=function(e){var a=!1,r=o.params,i=r.targetEl,n=r.targetX,s=r.targetY,c=r.targetWidth,u=r.targetHeight;return o.params.convertToPopover&&(i||void 0!==n&&void 0!==s)&&(o.params.forceToPopover||t.device.ios&&t.device.ipad||t.width>=768||t.device.desktop&&"aurora"===t.theme)&&(a=!0),a&&o.popoverHtml?((l=t.popover.create({content:o.popoverHtml,backdrop:o.params.backdrop,targetEl:i,targetX:n,targetY:s,targetWidth:c,targetHeight:u})).open(e),l.once("popoverOpened",function(){l.$el.find(".list-button, .item-link").each(function(e,t){$(t).on("click",d)})}),l.once("popoverClosed",function(){l.$el.find(".list-button, .item-link").each(function(e,t){$(t).off("click",d)}),Utils.nextTick(function(){l.destroy(),l=void 0})})):(o.$el=o.actionsHtml?$(o.actionsHtml):o.$el,o.$el[0].f7Modal=o,o.groups&&(o.$el.find(".actions-button").each(function(e,t){$(t).on("click",d)}),o.once("actionsClosed",function(){o.$el.find(".actions-button").each(function(e,t){$(t).off("click",d)})})),o.el=o.$el[0],p.call(o,e)),o},o.close=function(e){return l?l.close(e):c.call(o,e),o},Utils.extend(o,{app:t,$el:n,el:n?n[0]:void 0,$backdropEl:s,backdropEl:s&&s[0],type:"actions"}),o.params.closeOnEscape&&(o.on("open",function(){$(document).on("keydown",h)}),o.on("close",function(){$(document).off("keydown",h)})),o.on("opened",function(){(o.params.closeByBackdropClick||o.params.closeByOutsideClick)&&t.on("click",u)}),o.on("close",function(){(o.params.closeByBackdropClick||o.params.closeByOutsideClick)&&t.off("click",u)}),n&&(n[0].f7Modal=o),o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.groups;return('\n      <div class="actions-modal'+(this.params.grid?" actions-grid":"")+'">\n        '+e.map(function(e){return'<div class="actions-group">\n            '+e.map(function(e){var t=["actions-"+(e.label?"label":"button")],a=e.color,r=e.bg,i=e.bold,n=e.disabled,s=e.label,o=e.text,l=e.icon;return a&&t.push("color-"+a),r&&t.push("bg-color-"+r),i&&t.push("actions-button-bold"),n&&t.push("disabled"),s?'<div class="'+t.join(" ")+'">'+o+"</div>":('\n                <div class="'+t.join(" ")+'">\n                  '+(l?'<div class="actions-button-media">'+l+"</div>":"")+'\n                  <div class="actions-button-text">'+o+"</div>\n                </div>").trim()}).join("")+"\n          </div>"}).join("")+"\n      </div>\n    ").trim()},t.prototype.renderPopover=function(){return this.params.renderPopover?this.params.renderPopover.call(this,this):('\n      <div class="popover popover-from-actions">\n        <div class="popover-inner">\n          '+this.groups.map(function(e){return'\n            <div class="list">\n              <ul>\n                '+e.map(function(e){var t=[],a=e.color,r=e.bg,i=e.bold,n=e.disabled,s=e.label,o=e.text,l=e.icon;return a&&t.push("color-"+a),r&&t.push("bg-color-"+r),i&&t.push("popover-from-actions-bold"),n&&t.push("disabled"),s?(t.push("popover-from-actions-label"),'<li class="'+t.join(" ")+'">'+o+"</li>"):l?(t.push("item-link item-content"),'\n                      <li>\n                        <a class="'+t.join(" ")+'">\n                          <div class="item-media">\n                            '+l+'\n                          </div>\n                          <div class="item-inner">\n                            <div class="item-title">\n                              '+o+"\n                            </div>\n                          </div>\n                        </a>\n                      </li>\n                    "):(t.push("list-button"),'\n                    <li>\n                      <a class="'+t.join(" ")+'">'+o+"</a>\n                    </li>\n                  ")}).join("")+"\n              </ul>\n            </div>\n          "}).join("")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Actions$1={name:"actions",params:{actions:{convertToPopover:!0,forceToPopover:!1,backdrop:!0,backdropEl:void 0,closeByBackdropClick:!0,closeOnEscape:!1,render:null,renderPopover:null}},static:{Actions:Actions},create:function(){this.actions=ModalMethods({app:this,constructor:Actions,defaultSelector:".actions-modal.modal-in"})},clicks:{".actions-open":function(e,t){void 0===t&&(t={});this.actions.open(t.actions,t.animate)},".actions-close":function(e,t){void 0===t&&(t={});this.actions.close(t.actions,t.animate)}}},Sheet=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.sheet,a);e.call(this,t,r);var i,n,s,o=this;if(o.params=r,void 0===o.params.backdrop&&(o.params.backdrop="ios"!==t.theme),(i=o.params.el?$(o.params.el).eq(0):$(o.params.content).filter(function(e,t){return 1===t.nodeType}).eq(0))&&i.length>0&&i[0].f7Modal)return i[0].f7Modal;if(0===i.length)return o.destroy();function l(e){var a=e.target,r=$(a);!t.device.desktop&&t.device.cordova&&(window.Keyboard&&window.Keyboard.isVisible||window.cordova.plugins&&window.cordova.plugins.Keyboard&&window.cordova.plugins.Keyboard.isVisible)||0===r.closest(o.el).length&&(o.params.closeByBackdropClick&&o.params.backdrop&&o.backdropEl&&o.backdropEl===a?o.close():o.params.closeByOutsideClick&&o.close())}function p(e){27===e.keyCode&&o.params.closeOnEscape&&o.close()}o.params.backdrop&&o.params.backdropEl?n=$(o.params.backdropEl):o.params.backdrop&&0===(n=t.root.children(".sheet-backdrop")).length&&(n=$('<div class="sheet-backdrop"></div>'),t.root.append(n)),Utils.extend(o,{app:t,$el:i,el:i[0],$backdropEl:n,backdropEl:n&&n[0],type:"sheet"});var c,d,u,h,f,v,m,g,b,y,w,C,x=!1,k=!1;function E(e){x||!o.params.swipeToClose&&!o.params.swipeToStep||o.params.swipeHandler&&0===$(e.target).closest(o.params.swipeHandler).length||(x=!0,k=!1,c={x:"touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,y:"touchstart"===e.type?e.targetTouches[0].pageY:e.pageY},h=Utils.now(),u=void 0,v=i.hasClass("sheet-modal-top"))}function S(e){if(x){if(d={x:"touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,y:"touchmove"===e.type?e.targetTouches[0].pageY:e.pageY},void 0===u&&(u=!!(u||Math.abs(d.x-c.x)>Math.abs(d.y-c.y))),u)return x=!1,void(k=!1);var t;if(f=c.y-d.y,k||(y=i[0].offsetHeight,g=Utils.getTranslate(i[0],"y"),v?(w=o.params.swipeToClose?-y:-m,C=0):(w=0,C=o.params.swipeToClose?y:m),k=!0),b=g-f,b=Math.min(Math.max(b,w),C),e.preventDefault(),i.transition(0).transform("translate3d(0,"+b+"px,0)"),o.params.swipeToStep)t=v?1-b/m:(m-b)/m,t=Math.min(Math.max(t,0),1),i.trigger("sheet:stepprogress",t),o.emit("local::stepProgress sheetStepProgress",o,t)}}function T(){if(x=!1,k){k=!1,i.transform("").transition("");var e=f<0?"to-bottom":"to-top",t=Math.abs(f);if(0!==t&&b!==g){var a=(new Date).getTime()-h;if(o.params.swipeToStep){var r=v?"to-bottom":"to-top",n=v?"to-top":"to-bottom",s=Math.abs(b),l=Math.abs(m);if(a<300&&t>10)return e===r&&s<l&&(i.removeClass("modal-in-swipe-step"),i.trigger("sheet:stepprogress",1),o.emit("local::stepProgress sheetStepProgress",o,1),i.trigger("sheet:stepopen"),o.emit("local::stepOpen sheetStepOpen",o)),e===n&&s>l&&(o.params.swipeToClose?o.close():(i.addClass("modal-in-swipe-step"),i.trigger("sheet:stepprogress",0),o.emit("local::stepProgress sheetStepProgress",o,0),i.trigger("sheet:stepclose"),o.emit("local::stepClose sheetStepClose",o))),void(e===n&&s<=l&&(i.addClass("modal-in-swipe-step"),i.trigger("sheet:stepprogress",0),o.emit("local::stepProgress sheetStepProgress",o,0),i.trigger("sheet:stepclose"),o.emit("local::stepClose sheetStepClose",o)));if(a>=300){var p=!i.hasClass("modal-in-swipe-step");p?p&&(s>l+(y-l)/2?o.params.swipeToClose&&o.close():s>l/2&&(i.addClass("modal-in-swipe-step"),i.trigger("sheet:stepprogress",0),o.emit("local::stepProgress sheetStepProgress",o,0),i.trigger("sheet:stepclose"),o.emit("local::stepClose sheetStepClose",o))):s<l/2?(i.removeClass("modal-in-swipe-step"),i.trigger("sheet:stepprogress",1),o.emit("local::stepProgress sheetStepProgress",o,1),i.trigger("sheet:stepopen"),o.emit("local::stepOpen sheetStepOpen",o)):s-l>(y-l)/2&&o.params.swipeToClose&&o.close()}}else{if(e!==(v?"to-top":"to-bottom"))return;(a<300&&t>20||a>=300&&t>y/2)&&o.close()}}}}function M(e){var t=i.find(".sheet-modal-swipe-step").eq(0);t.length&&(m=i.hasClass("sheet-modal-top")?-(t.offset().top-i.offset().top+t[0].offsetHeight):i[0].offsetHeight-(t.offset().top-i.offset().top+t[0].offsetHeight),i[0].style.setProperty("--f7-sheet-swipe-step",m+"px"),e||i.addClass("modal-in-swipe-step"))}function P(){M(!0)}var O=!!Support.passiveListener&&{passive:!0};return(o.params.swipeToClose||o.params.swipeToStep)&&(i.on(t.touchEvents.start,E,O),t.on("touchmove",S),t.on("touchend:passive",T),o.once("sheetDestroy",function(){i.off(t.touchEvents.start,E,O),t.off("touchmove",S),t.off("touchend:passive",T)})),o.on("sheetOpen",function(){o.params.closeOnEscape&&$(document).on("keydown",p),o.params.swipeToStep&&(M(),t.on("resize",P)),o.params.scrollToEl&&function(){var e=$(o.params.scrollToEl).eq(0);if(0!==e.length&&0!==(s=e.parents(".page-content")).length){var t,a=parseInt(s.css("padding-top"),10),r=parseInt(s.css("padding-bottom"),10),n=s[0].offsetHeight-a-i.height(),l=s[0].scrollHeight-a-i.height(),p=s.scrollTop(),c=e.offset().top-a+e[0].offsetHeight;if(c>n){var d=p+c-n;d+n>l&&(t=d+n-l+r,n===l&&(t=i.height()),s.css({"padding-bottom":t+"px"})),s.scrollTop(d,300)}}}()}),o.on("sheetOpened",function(){(o.params.closeByOutsideClick||o.params.closeByBackdropClick)&&t.on("click",l)}),o.on("sheetClose",function(){o.params.swipeToStep&&(i.removeClass("modal-in-swipe-step"),t.off("resize",P)),o.params.closeOnEscape&&$(document).off("keydown",p),o.params.scrollToEl&&s&&s.length>0&&s.css({"padding-bottom":""}),(o.params.closeByOutsideClick||o.params.closeByBackdropClick)&&t.off("click",l)}),o.stepOpen=function(){i.removeClass("modal-in-swipe-step")},o.stepClose=function(){i.addClass("modal-in-swipe-step")},o.stepToggle=function(){i.toggleClass("modal-in-swipe-step")},i[0].f7Modal=o,o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t}(Modal),Sheet$1={name:"sheet",params:{sheet:{backdrop:void 0,backdropEl:void 0,closeByBackdropClick:!0,closeByOutsideClick:!1,closeOnEscape:!1,swipeToClose:!1,swipeToStep:!1,swipeHandler:null}},static:{Sheet:Sheet},create:function(){var e=this;e.sheet=Utils.extend({},ModalMethods({app:e,constructor:Sheet,defaultSelector:".sheet-modal.modal-in"}),{stepOpen:function(t){var a=e.sheet.get(t);if(a&&a.stepOpen)return a.stepOpen()},stepClose:function(t){var a=e.sheet.get(t);if(a&&a.stepClose)return a.stepClose()},stepToggle:function(t){var a=e.sheet.get(t);if(a&&a.stepToggle)return a.stepToggle()}})},clicks:{".sheet-open":function(e,t){void 0===t&&(t={});$(".sheet-modal.modal-in").length>0&&t.sheet&&$(t.sheet)[0]!==$(".sheet-modal.modal-in")[0]&&this.sheet.close(".sheet-modal.modal-in"),this.sheet.open(t.sheet,t.animate)},".sheet-close":function(e,t){void 0===t&&(t={});this.sheet.close(t.sheet,t.animate)}}},Toast=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.toast,a);e.call(this,t,r);var i=this;i.app=t,i.params=r;var n,s,o=i.params,l=o.closeButton,p=o.closeTimeout;if(i.params.el)n=$(i.params.el);else{var c=i.render();n=$(c)}return n&&n.length>0&&n[0].f7Modal?n[0].f7Modal:0===n.length?i.destroy():(Utils.extend(i,{$el:n,el:n[0],type:"toast"}),n[0].f7Modal=i,l&&(n.find(".toast-button").on("click",function(){i.emit("local::closeButtonClick toastCloseButtonClick",i),i.close()}),i.on("beforeDestroy",function(){n.find(".toast-button").off("click")})),i.on("open",function(){$(".toast.modal-in").each(function(e,a){var r=t.toast.get(a);a!==i.el&&r&&r.close()}),p&&(s=Utils.nextTick(function(){i.close()},p))}),i.on("close",function(){win.clearTimeout(s)}),i.params.destroyOnClose&&i.once("closed",function(){setTimeout(function(){i.destroy()},0)}),i)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.position,a=e.cssClass,r=e.icon,i=e.text,n=e.closeButton,s=e.closeButtonColor,o=e.closeButtonText;return('\n      <div class="toast toast-'+t+" "+(a||"")+" "+(r?"toast-with-icon":"")+'">\n        <div class="toast-content">\n          '+(r?'<div class="toast-icon">'+r+"</div>":"")+'\n          <div class="toast-text">'+i+"</div>\n          "+(n&&!r?('\n          <a class="toast-button button '+(s?"color-"+s:"")+'">'+o+"</a>\n          ").trim():"")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Toast$1={name:"toast",static:{Toast:Toast},create:function(){var e=this;e.toast=Utils.extend({},ModalMethods({app:e,constructor:Toast,defaultSelector:".toast.modal-in"}),{show:function(t){return Utils.extend(t,{destroyOnClose:!0}),new Toast(e,t).open()}})},params:{toast:{icon:null,text:null,position:"bottom",closeButton:!1,closeButtonColor:null,closeButtonText:"Ok",closeTimeout:null,cssClass:null,render:null}}},Preloader={init:function(e){var t=$(e);0===t.length||t.children(".preloader-inner").length>0||t.children(".preloader-inner-line").length>0||t.append(Utils[this.theme+"PreloaderContent"])},visible:!1,show:function(e){void 0===e&&(e="white");if(!Preloader.visible){var t=Utils[this.theme+"PreloaderContent"]||"";$("html").addClass("with-modal-preloader"),this.root.append('\n      <div class="preloader-backdrop"></div>\n      <div class="preloader-modal">\n        <div class="preloader color-'+e+'">'+t+"</div>\n      </div>\n    "),Preloader.visible=!0}},hide:function(){Preloader.visible&&($("html").removeClass("with-modal-preloader"),this.root.find(".preloader-backdrop, .preloader-modal").remove(),Preloader.visible=!1)}},Preloader$1={name:"preloader",create:function(){Utils.extend(this,{preloader:{init:Preloader.init.bind(this),show:Preloader.show.bind(this),hide:Preloader.hide.bind(this)}})},on:{photoBrowserOpen:function(e){var t=this;e.$el.find(".preloader").each(function(e,a){t.preloader.init(a)})},tabMounted:function(e){var t=this;$(e).find(".preloader").each(function(e,a){t.preloader.init(a)})},pageInit:function(e){var t=this;e.$el.find(".preloader").each(function(e,a){t.preloader.init(a)})}},vnode:{preloader:{insert:function(e){var t=e.elm;this.preloader.init(t)}}}},Progressbar={set:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=t[0],i=t[1],n=t[2];if("number"==typeof t[0]&&(i=(e=t)[0],n=e[1],r=this.root),null==i)return r;i||(i=0);var s=$(r||this.root);if(0===s.length)return r;var o,l=Math.min(Math.max(i,0),100);if(0===(o=s.hasClass("progressbar")?s.eq(0):s.children(".progressbar")).length||o.hasClass("progressbar-infinite"))return o;var p=o.children("span");return 0===p.length&&(p=$("<span></span>"),o.append(p)),p.transition(void 0!==n?n:"").transform("translate3d("+(-100+l)+"%,0,0)"),o[0]},show:function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var i=a[0],n=a[1],s=a[2],o="determined";2===a.length?"string"!=typeof a[0]&&"object"!=typeof a[0]||"string"!=typeof a[1]?"number"==typeof a[0]&&"string"==typeof a[1]&&(n=(t=a)[0],s=t[1],i=this.root):(i=(e=a)[0],s=e[1],n=e[2],o="infinite"):1===a.length?"number"==typeof a[0]?(i=this.root,n=a[0]):"string"==typeof a[0]&&(o="infinite",i=this.root,s=a[0]):0===a.length&&(o="infinite",i=this.root);var l,p=$(i);if(0!==p.length)return p.hasClass("progressbar")||p.hasClass("progressbar-infinite")?l=p:0===(l=p.children(".progressbar:not(.progressbar-out), .progressbar-infinite:not(.progressbar-out)")).length&&(l=$('\n          <span class="progressbar'+("infinite"===o?"-infinite":"")+(s?" color-"+s:"")+' progressbar-in">\n            '+("infinite"===o?"":"<span></span>")+"\n          </span>"),p.append(l)),void 0!==n&&this.progressbar.set(l,n),l[0]},hide:function(e,t){void 0===t&&(t=!0);var a,r=$(e||this.root);if(0!==r.length)return 0===(a=r.hasClass("progressbar")||r.hasClass("progressbar-infinite")?r:r.children(".progressbar, .progressbar-infinite")).length||!a.hasClass("progressbar-in")||a.hasClass("progressbar-out")?a:(a.removeClass("progressbar-in").addClass("progressbar-out").animationEnd(function(){t&&a.remove()}),a)}},Progressbar$1={name:"progressbar",create:function(){Utils.extend(this,{progressbar:{set:Progressbar.set.bind(this),show:Progressbar.show.bind(this),hide:Progressbar.hide.bind(this)}})},on:{tabMounted:function(e){var t=this;$(e).find(".progressbar").each(function(e,a){var r=$(a);t.progressbar.set(r,r.attr("data-progress"))})},pageInit:function(e){var t=this;e.$el.find(".progressbar").each(function(e,a){var r=$(a);t.progressbar.set(r,r.attr("data-progress"))})}},vnode:{progressbar:{insert:function(e){var t=e.elm;this.progressbar.set(t,t.getAttribute("data-progress"))},update:function(e){var t=e.elm;this.progressbar.set(t,t.getAttribute("data-progress"))}}}},Sortable={init:function(){var e,t,a,r,i,n,s,o,l,p,c,d,u,h,f,v,m,g,b,y,w=this;var C=!!w.support.passiveListener&&{passive:!1,capture:!1};$(doc).on(w.touchEvents.start,".list.sortable .sortable-handler",function(r){t=!1,e=!0,a="touchstart"===r.type?r.targetTouches[0].pageY:r.pageY,i=$(this).parent("li"),u=i.index(),s=i.parents(".sortable");var o=i.parents(".list-group");o.length&&o.parents(s).length&&(s=o),n=s.children("ul").children("li:not(.disallow-sorting):not(.no-sorting)"),w.panel&&(w.panel.allowOpen=!1),w.swipeout&&(w.swipeout.allow=!1)},C),w.on("touchmove:active",function(u){if(e&&i){var w="touchmove"===u.type?u.targetTouches[0].pageY:u.pageY;if(!t){h=i.parents(".page"),f=i.parents(".page-content");var C=parseInt(f.css("padding-top"),10),x=parseInt(f.css("padding-bottom"),10);y=f[0].scrollTop,m=h.offset().top+C,v=h.height()-C-x,i.addClass("sorting"),s.addClass("sortable-sorting"),g=i[0].offsetTop,l=i[0].offsetTop,p=i.parent().height()-g-i.height(),o=i[0].offsetHeight,b=i.offset().top}t=!0,u.preventDefault(),u.f7PreventSwipePanel=!0,r=w-a;var k=f[0].scrollTop-y,E=Math.min(Math.max(r+k,-l),p);i.transform("translate3d(0,"+E+"px,0)");var S,T=!0;r+k+44<-l&&(T=!1),r+k-44>p&&(T=!1),d=void 0,c=void 0,T&&(b+r+o+44>m+v&&(S=b+r+o+44-(m+v)),b+r<m+44&&(S=b+r-m-44),S&&(f[0].scrollTop+=S)),n.each(function(e,t){var a=$(t);if(a[0]!==i[0]){var r=a[0].offsetTop,n=a.height(),s=g+E;s>=r-n/2&&i.index()<a.index()?(a.transform("translate3d(0, "+-o+"px,0)"),c=a,d=void 0):s<=r+n/2&&i.index()>a.index()?(a.transform("translate3d(0, "+o+"px,0)"),c=void 0,d||(d=a)):a.transform("translate3d(0, 0%,0)")}})}}),w.on("touchend:passive",function(){if(!e||!t)return t=!1,void((e=!1)&&!t&&(w.panel&&(w.panel.allowOpen=!0),w.swipeout&&(w.swipeout.allow=!0)));var a;w.panel&&(w.panel.allowOpen=!0),w.swipeout&&(w.swipeout.allow=!0),n.transform(""),i.removeClass("sorting"),s.removeClass("sortable-sorting"),c?a=c.index():d&&(a=d.index());var r=s.dataset().sortableMoveElements;if(void 0===r&&(r=w.params.sortable.moveElements),r&&(c&&i.insertAfter(c),d&&i.insertBefore(d)),(c||d)&&s.hasClass("virtual-list")){void 0===(u=i[0].f7VirtualListIndex)&&(u=i.attr("data-virtual-list-index")),d?void 0===(a=d[0].f7VirtualListIndex)&&(a=d.attr("data-virtual-list-index")):void 0===(a=c[0].f7VirtualListIndex)&&(a=c.attr("data-virtual-list-index")),a=null!==a?parseInt(a,10):void 0;var o=s[0].f7VirtualList;o&&o.moveItem(u,a)}void 0===a||Number.isNaN(a)||a===u||(i.trigger("sortable:sort",{from:u,to:a}),w.emit("sortableSort",i[0],{from:u,to:a})),d=void 0,c=void 0,e=!1,t=!1})},enable:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.addClass("sortable-enabled"),t.trigger("sortable:enable"),this.emit("sortableEnable",t[0]))},disable:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.removeClass("sortable-enabled"),t.trigger("sortable:disable"),this.emit("sortableDisable",t[0]))},toggle:function(e){void 0===e&&(e=".list.sortable");var t=$(e);0!==t.length&&(t.hasClass("sortable-enabled")?this.sortable.disable(t):this.sortable.enable(t))}},Sortable$1={name:"sortable",params:{sortable:{moveElements:!0}},create:function(){Utils.extend(this,{sortable:{init:Sortable.init.bind(this),enable:Sortable.enable.bind(this),disable:Sortable.disable.bind(this),toggle:Sortable.toggle.bind(this)}})},on:{init:function(){this.params.sortable&&this.sortable.init()}},clicks:{".sortable-enable":function(e,t){void 0===t&&(t={});this.sortable.enable(t.sortable)},".sortable-disable":function(e,t){void 0===t&&(t={});this.sortable.disable(t.sortable)},".sortable-toggle":function(e,t){void 0===t&&(t={});this.sortable.toggle(t.sortable)}}},Swipeout={init:function(){var e,t,a,r,i,n,s,o,l,p,c,d,u,h,f,v,m,g,b,y,w,C=this,x={};var k=!!C.support.passiveListener&&{passive:!0};C.on("touchstart",function(e){if(Swipeout.el){var t=$(e.target);$(Swipeout.el).is(t[0])||t.parents(".swipeout").is(Swipeout.el)||t.hasClass("modal-in")||(t.attr("class")||"").indexOf("-backdrop")>0||t.hasClass("actions-modal")||t.parents(".actions-modal.modal-in, .dialog.modal-in").length>0||C.swipeout.close(Swipeout.el)}}),$(doc).on(C.touchEvents.start,"li.swipeout",function(i){Swipeout.allow&&(t=!1,e=!0,a=void 0,x.x="touchstart"===i.type?i.targetTouches[0].pageX:i.pageX,x.y="touchstart"===i.type?i.targetTouches[0].pageY:i.pageY,r=(new Date).getTime(),n=$(this))},k),C.on("touchmove:active",function(r){if(e){var k="touchmove"===r.type?r.targetTouches[0].pageX:r.pageX,E="touchmove"===r.type?r.targetTouches[0].pageY:r.pageY;if(void 0===a&&(a=!!(a||Math.abs(E-x.y)>Math.abs(k-x.x))),a)e=!1;else{if(!t){if($(".list.sortable-opened").length>0)return;s=n.find(".swipeout-content"),o=n.find(".swipeout-actions-right"),l=n.find(".swipeout-actions-left"),p=null,c=null,f=null,v=null,b=null,g=null,l.length>0&&(p=l.outerWidth(),f=l.children("a"),g=l.find(".swipeout-overswipe")),o.length>0&&(c=o.outerWidth(),v=o.children("a"),b=o.find(".swipeout-overswipe")),(u=n.hasClass("swipeout-opened"))&&(h=n.find(".swipeout-actions-left.swipeout-actions-opened").length>0?"left":"right"),n.removeClass("swipeout-transitioning"),C.params.swipeout.noFollow||(n.find(".swipeout-actions-opened").removeClass("swipeout-actions-opened"),n.removeClass("swipeout-opened"))}if(t=!0,r.preventDefault(),i=k-x.x,d=i,u&&("right"===h?d-=c:d+=p),d>0&&0===l.length||d<0&&0===o.length){if(!u)return e=!1,t=!1,s.transform(""),v&&v.length>0&&v.transform(""),void(f&&f.length>0&&f.transform(""));d=0}var S,T;if(d<0?m="to-left":d>0?m="to-right":m||(m="to-left"),r.f7PreventSwipePanel=!0,C.params.swipeout.noFollow)return u?("right"===h&&i>0&&C.swipeout.close(n),"left"===h&&i<0&&C.swipeout.close(n)):(i<0&&o.length>0&&C.swipeout.open(n,"right"),i>0&&l.length>0&&C.swipeout.open(n,"left")),e=!1,void(t=!1);if(y=!1,w=!1,o.length>0){var M=d;T=M/c,M<-c&&(M=-c-Math.pow(-M-c,.8),d=M,b.length>0&&(w=!0)),"to-left"!==m&&(T=0,M=0),v.each(function(e,t){var a=$(t);void 0===t.f7SwipeoutButtonOffset&&(a[0].f7SwipeoutButtonOffset=t.offsetLeft),S=t.f7SwipeoutButtonOffset,b.length>0&&a.hasClass("swipeout-overswipe")&&"to-left"===m&&(a.css({left:(w?-S:0)+"px"}),w?(a.hasClass("swipeout-overswipe-active")||(n.trigger("swipeout:overswipeenter"),C.emit("swipeoutOverswipeEnter",n[0])),a.addClass("swipeout-overswipe-active")):(a.hasClass("swipeout-overswipe-active")&&(n.trigger("swipeout:overswipeexit"),C.emit("swipeoutOverswipeExit",n[0])),a.removeClass("swipeout-overswipe-active"))),a.transform("translate3d("+(M-S*(1+Math.max(T,-1)))+"px,0,0)")})}if(l.length>0){var P=d;T=P/p,P>p&&(P=p+Math.pow(P-p,.8),d=P,g.length>0&&(y=!0)),"to-right"!==m&&(P=0,T=0),f.each(function(e,t){var a=$(t);void 0===t.f7SwipeoutButtonOffset&&(a[0].f7SwipeoutButtonOffset=p-t.offsetLeft-t.offsetWidth),S=t.f7SwipeoutButtonOffset,g.length>0&&a.hasClass("swipeout-overswipe")&&"to-right"===m&&(a.css({left:(y?S:0)+"px"}),y?(a.hasClass("swipeout-overswipe-active")||(n.trigger("swipeout:overswipeenter"),C.emit("swipeoutOverswipeEnter",n[0])),a.addClass("swipeout-overswipe-active")):(a.hasClass("swipeout-overswipe-active")&&(n.trigger("swipeout:overswipeexit"),C.emit("swipeoutOverswipeExit",n[0])),a.removeClass("swipeout-overswipe-active"))),f.length>1&&a.css("z-index",f.length-e),a.transform("translate3d("+(P+S*(1-Math.min(T,1)))+"px,0,0)")})}n.trigger("swipeout",T),C.emit("swipeout",n[0],T),s.transform("translate3d("+d+"px,0,0)")}}}),C.on("touchend:passive",function(){if(!e||!t)return e=!1,void(t=!1);e=!1,t=!1;var a,h,g,b,x=(new Date).getTime()-r,k="to-left"===m?o:l,E="to-left"===m?c:p;if(a=x<300&&(i<-10&&"to-left"===m||i>10&&"to-right"===m)||x>=300&&Math.abs(d)>E/2?"open":"close",x<300&&(0===Math.abs(d)&&(a="close"),Math.abs(d)===E&&(a="open")),"open"===a){Swipeout.el=n[0],n.trigger("swipeout:open"),C.emit("swipeoutOpen",n[0]),n.addClass("swipeout-opened swipeout-transitioning");var S="to-left"===m?-E:E;if(s.transform("translate3d("+S+"px,0,0)"),k.addClass("swipeout-actions-opened"),h="to-left"===m?v:f)for(g=0;g<h.length;g+=1)$(h[g]).transform("translate3d("+S+"px,0,0)");w&&o.find(".swipeout-overswipe").trigger("click","f7Overswipe"),y&&l.find(".swipeout-overswipe").trigger("click","f7Overswipe")}else n.trigger("swipeout:close"),C.emit("swipeoutClose",n[0]),Swipeout.el=void 0,n.addClass("swipeout-transitioning").removeClass("swipeout-opened"),s.transform(""),k.removeClass("swipeout-actions-opened");f&&f.length>0&&f!==h&&f.each(function(e,t){var a=$(t);void 0===(b=t.f7SwipeoutButtonOffset)&&(a[0].f7SwipeoutButtonOffset=p-t.offsetLeft-t.offsetWidth),a.transform("translate3d("+b+"px,0,0)")}),v&&v.length>0&&v!==h&&v.each(function(e,t){var a=$(t);void 0===(b=t.f7SwipeoutButtonOffset)&&(a[0].f7SwipeoutButtonOffset=t.offsetLeft),a.transform("translate3d("+-b+"px,0,0)")}),s.transitionEnd(function(){u&&"open"===a||!u&&"close"===a||(n.trigger("open"===a?"swipeout:opened":"swipeout:closed"),C.emit("open"===a?"swipeoutOpened":"swipeoutClosed",n[0]),n.removeClass("swipeout-transitioning"),u&&"close"===a&&(o.length>0&&v.transform(""),l.length>0&&f.transform("")))})})},allow:!0,el:void 0,open:function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];var r=this,i=t[0],n=t[1],s=t[2];"function"==typeof t[1]&&(i=(e=t)[0],s=e[1],n=e[2]);var o=$(i).eq(0);if(0!==o.length&&o.hasClass("swipeout")&&!o.hasClass("swipeout-opened")){n||(n=o.find(".swipeout-actions-right").length>0?"right":"left");var l=o.find(".swipeout-actions-"+n),p=o.find(".swipeout-content");if(0!==l.length){o.trigger("swipeout:open").addClass("swipeout-opened").removeClass("swipeout-transitioning"),r.emit("swipeoutOpen",o[0]),l.addClass("swipeout-actions-opened");var c=l.children("a"),d=l.outerWidth(),u="right"===n?-d:d;c.length>1&&c.each(function(e,t){var a=$(t);"right"===n?a.transform("translate3d("+-t.offsetLeft+"px,0,0)"):a.css("z-index",c.length-e).transform("translate3d("+(d-t.offsetWidth-t.offsetLeft)+"px,0,0)")}),o.addClass("swipeout-transitioning"),p.transitionEnd(function(){o.trigger("swipeout:opened"),r.emit("swipeoutOpened",o[0]),s&&s.call(o[0])}),Utils.nextFrame(function(){c.transform("translate3d("+u+"px,0,0)"),p.transform("translate3d("+u+"px,0,0)")}),Swipeout.el=o[0]}}},close:function(e,t){var a=this,r=$(e).eq(0);if(0!==r.length&&r.hasClass("swipeout-opened")){var i,n=r.find(".swipeout-actions-opened").hasClass("swipeout-actions-right")?"right":"left",s=r.find(".swipeout-actions-opened").removeClass("swipeout-actions-opened"),o=s.children("a"),l=s.outerWidth();Swipeout.allow=!1,r.trigger("swipeout:close"),a.emit("swipeoutClose",r[0]),r.removeClass("swipeout-opened").addClass("swipeout-transitioning"),r.find(".swipeout-content").transform("").transitionEnd(p),i=setTimeout(p,500),o.each(function(e,t){var a=$(t);"right"===n?a.transform("translate3d("+-t.offsetLeft+"px,0,0)"):a.transform("translate3d("+(l-t.offsetWidth-t.offsetLeft)+"px,0,0)"),a.css({left:"0px"}).removeClass("swipeout-overswipe-active")}),Swipeout.el&&Swipeout.el===r[0]&&(Swipeout.el=void 0)}function p(){Swipeout.allow=!0,r.hasClass("swipeout-opened")||(r.removeClass("swipeout-transitioning"),o.transform(""),r.trigger("swipeout:closed"),a.emit("swipeoutClosed",r[0]),t&&t.call(r[0]),i&&clearTimeout(i))}},delete:function(e,t){var a=this,r=$(e).eq(0);0!==r.length&&(Swipeout.el=void 0,r.trigger("swipeout:delete"),a.emit("swipeoutDelete",r[0]),r.css({height:r.outerHeight()+"px"}),r.transitionEnd(function(){if(r.trigger("swipeout:deleted"),a.emit("swipeoutDeleted",r[0]),t&&t.call(r[0]),r.parents(".virtual-list").length>0){var e=r.parents(".virtual-list")[0].f7VirtualList,i=r[0].f7VirtualListIndex;e&&void 0!==i&&e.deleteItem(i)}else a.params.swipeout.removeElements?a.params.swipeout.removeElementsWithTimeout?setTimeout(function(){r.remove()},a.params.swipeout.removeElementsTimeout):r.remove():r.removeClass("swipeout-deleting swipeout-transitioning")}),Utils.nextFrame(function(){r.addClass("swipeout-deleting swipeout-transitioning").css({height:"0px"}).find(".swipeout-content").transform("translate3d(-100%,0,0)")}))}},Swipeout$1={name:"swipeout",params:{swipeout:{actionsNoFold:!1,noFollow:!1,removeElements:!0,removeElementsWithTimeout:!1,removeElementsTimeout:0}},create:function(){Utils.extend(this,{swipeout:{init:Swipeout.init.bind(this),open:Swipeout.open.bind(this),close:Swipeout.close.bind(this),delete:Swipeout.delete.bind(this)}}),Object.defineProperty(this.swipeout,"el",{enumerable:!0,configurable:!0,get:function(){return Swipeout.el},set:function(e){Swipeout.el=e}}),Object.defineProperty(this.swipeout,"allow",{enumerable:!0,configurable:!0,get:function(){return Swipeout.allow},set:function(e){Swipeout.allow=e}})},clicks:{".swipeout-open":function(e,t){void 0===t&&(t={});this.swipeout.open(t.swipeout,t.side)},".swipeout-close":function(e){var t=e.closest(".swipeout");0!==t.length&&this.swipeout.close(t)},".swipeout-delete":function(e,t){void 0===t&&(t={});var a=this,r=e.closest(".swipeout");if(0!==r.length){var i=t.confirm,n=t.confirmTitle;t.confirm?a.dialog.confirm(i,n,function(){a.swipeout.delete(r)}):a.swipeout.delete(r)}}},on:{init:function(){this.params.swipeout&&this.swipeout.init()}}},Accordion={toggleClicked:function(e){var t=e.closest(".accordion-item").eq(0);t.length||(t=e.parents("li").eq(0));var a=e.parents(".accordion-item-content").eq(0);a.length&&a.parents(t).length||e.parents("li").length>1&&e.parents("li")[0]!==t[0]||this.accordion.toggle(t)},open:function(e){var t=this,a=$(e),r=!1;function i(){r=!0}if(a.trigger("accordion:beforeopen",{prevent:i},i),t.emit("accordionBeforeOpen",a[0],i),!r){var n=a.parents(".accordion-list").eq(0),s=a.children(".accordion-item-content");if(s.removeAttr("aria-hidden"),0===s.length&&(s=a.find(".accordion-item-content")),0!==s.length){var o=n.length>0&&a.parent().children(".accordion-item-opened");o.length>0&&t.accordion.close(o),s.transitionEnd(function(){a.hasClass("accordion-item-opened")?(s.transition(0),s.css("height","auto"),Utils.nextFrame(function(){s.transition(""),a.trigger("accordion:opened"),t.emit("accordionOpened",a[0])})):(s.css("height",""),a.trigger("accordion:closed"),t.emit("accordionClosed",a[0]))}),s.css("height",s[0].scrollHeight+"px"),a.trigger("accordion:open"),a.addClass("accordion-item-opened"),t.emit("accordionOpen",a[0])}}},close:function(e){var t=this,a=$(e),r=!1;function i(){r=!0}if(a.trigger("accordion:beforeclose",{prevent:i},i),t.emit("accordionBeforeClose",a[0],i),!r){var n=a.children(".accordion-item-content");0===n.length&&(n=a.find(".accordion-item-content")),a.removeClass("accordion-item-opened"),n.attr("aria-hidden",!0),n.transition(0),n.css("height",n[0].scrollHeight+"px"),n.transitionEnd(function(){a.hasClass("accordion-item-opened")?(n.transition(0),n.css("height","auto"),Utils.nextFrame(function(){n.transition(""),a.trigger("accordion:opened"),t.emit("accordionOpened",a[0])})):(n.css("height",""),a.trigger("accordion:closed"),t.emit("accordionClosed",a[0]))}),Utils.nextFrame(function(){n.transition(""),n.css("height",""),a.trigger("accordion:close"),t.emit("accordionClose",a[0])})}},toggle:function(e){var t=$(e);0!==t.length&&(t.hasClass("accordion-item-opened")?this.accordion.close(e):this.accordion.open(e))}},Accordion$1={name:"accordion",create:function(){Utils.extend(this,{accordion:{open:Accordion.open.bind(this),close:Accordion.close.bind(this),toggle:Accordion.toggle.bind(this)}})},clicks:{".accordion-item .item-link, .accordion-item-toggle, .links-list.accordion-list > ul > li > a":function(e){Accordion.toggleClicked.call(this,e)}}},ContactsList={name:"contactsList"},VirtualList=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i=this;"md"===t.theme?r=48:"ios"===t.theme?r=44:"aurora"===t.theme&&(r=38);var n={cols:1,height:r,cache:!0,dynamicHeightBufferSize:1,showFilteredItemsOnly:!1,renderExternal:void 0,setListHeight:!0,searchByItem:void 0,searchAll:void 0,itemTemplate:void 0,ul:null,createUl:!0,scrollableParentEl:void 0,renderItem:function(e){return('\n          <li>\n            <div class="item-content">\n              <div class="item-inner">\n                <div class="item-title">'+e+"</div>\n              </div>\n            </div>\n          </li>\n        ").trim()},on:{}};if(i.useModulesParams(n),i.params=Utils.extend(n,a),void 0!==i.params.height&&i.params.height||(i.params.height=r),i.$el=$(a.el),i.el=i.$el[0],0!==i.$el.length){i.$el[0].f7VirtualList=i,i.items=i.params.items,i.params.showFilteredItemsOnly&&(i.filteredItems=[]),i.params.itemTemplate?"string"==typeof i.params.itemTemplate?i.renderItem=t.t7.compile(i.params.itemTemplate):"function"==typeof i.params.itemTemplate&&(i.renderItem=i.params.itemTemplate):i.params.renderItem&&(i.renderItem=i.params.renderItem),i.$pageContentEl=i.$el.parents(".page-content"),i.pageContentEl=i.$pageContentEl[0],i.$scrollableParentEl=i.params.scrollableParentEl?$(i.params.scrollableParentEl).eq(0):i.$pageContentEl,!i.$scrollableParentEl.length&&i.$pageContentEl.length&&(i.$scrollableParentEl=i.$pageContentEl),i.scrollableParentEl=i.$scrollableParentEl[0],void 0!==i.params.updatableScroll?i.updatableScroll=i.params.updatableScroll:(i.updatableScroll=!0,Device.ios&&Device.osVersion.split(".")[0]<8&&(i.updatableScroll=!1));var s,o=i.params.ul;i.$ul=o?$(i.params.ul):i.$el.children("ul"),0===i.$ul.length&&i.params.createUl&&(i.$el.append("<ul></ul>"),i.$ul=i.$el.children("ul")),i.ul=i.$ul[0],s=i.ul||i.params.createUl?i.$ul:i.$el,Utils.extend(i,{$itemsWrapEl:s,itemsWrapEl:s[0],domCache:{},displayDomCache:{},tempDomElement:doc.createElement("ul"),lastRepaintY:null,fragment:doc.createDocumentFragment(),pageHeight:void 0,rowsPerScreen:void 0,rowsBefore:void 0,rowsAfter:void 0,rowsToRender:void 0,maxBufferHeight:0,listHeight:void 0,dynamicHeight:"function"==typeof i.params.height}),i.useModules();var l,p,c,d,u=i.handleScroll.bind(i),h=i.handleResize.bind(i);return i.attachEvents=function(){l=i.$el.parents(".page").eq(0),p=i.$el.parents(".tab").eq(0),c=i.$el.parents(".panel").eq(0),d=i.$el.parents(".popup").eq(0),i.$scrollableParentEl.on("scroll",u),l&&l.on("page:reinit",h),p&&p.on("tab:show",h),c&&c.on("panel:open",h),d&&d.on("popup:open",h),t.on("resize",h)},i.detachEvents=function(){i.$scrollableParentEl.off("scroll",u),l&&l.off("page:reinit",h),p&&p.off("tab:show",h),c&&c.off("panel:open",h),d&&d.off("popup:open",h),t.off("resize",h)},i.init(),i}}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setListSize=function(){var e=this,t=e.filteredItems||e.items;if(e.pageHeight=e.$scrollableParentEl[0].offsetHeight,e.dynamicHeight){e.listHeight=0,e.heights=[];for(var a=0;a<t.length;a+=1){var r=e.params.height(t[a]);e.listHeight+=r,e.heights.push(r)}}else e.listHeight=Math.ceil(t.length/e.params.cols)*e.params.height,e.rowsPerScreen=Math.ceil(e.pageHeight/e.params.height),e.rowsBefore=e.params.rowsBefore||2*e.rowsPerScreen,e.rowsAfter=e.params.rowsAfter||e.rowsPerScreen,e.rowsToRender=e.rowsPerScreen+e.rowsBefore+e.rowsAfter,e.maxBufferHeight=e.rowsBefore/2*e.params.height;(e.updatableScroll||e.params.setListHeight)&&e.$itemsWrapEl.css({height:e.listHeight+"px"})},t.prototype.render=function(e,t){var a=this;e&&(a.lastRepaintY=null);var r=-(a.$el[0].getBoundingClientRect().top-a.$scrollableParentEl[0].getBoundingClientRect().top);if(void 0!==t&&(r=t),null===a.lastRepaintY||Math.abs(r-a.lastRepaintY)>a.maxBufferHeight||!a.updatableScroll&&a.$scrollableParentEl[0].scrollTop+a.pageHeight>=a.$scrollableParentEl[0].scrollHeight){a.lastRepaintY=r;var i,n,s,o=a.filteredItems||a.items,l=0,p=0;if(a.dynamicHeight){var c,d=0;a.maxBufferHeight=a.pageHeight;for(var u=0;u<a.heights.length;u+=1)c=a.heights[u],void 0===i&&(d+c>=r-2*a.pageHeight*a.params.dynamicHeightBufferSize?i=u:l+=c),void 0===n&&((d+c>=r+2*a.pageHeight*a.params.dynamicHeightBufferSize||u===a.heights.length-1)&&(n=u+1),p+=c),d+=c;n=Math.min(n,o.length)}else(i=(parseInt(r/a.params.height,10)-a.rowsBefore)*a.params.cols)<0&&(i=0),n=Math.min(i+a.rowsToRender*a.params.cols,o.length);var h,f=[];for(a.reachEnd=!1,h=i;h<n;h+=1){var v=void 0,m=a.items.indexOf(o[h]);h===i&&(a.currentFromIndex=m),h===n-1&&(a.currentToIndex=m),a.filteredItems?a.items[m]===a.filteredItems[a.filteredItems.length-1]&&(a.reachEnd=!0):m===a.items.length-1&&(a.reachEnd=!0),a.params.renderExternal?f.push(o[h]):a.domCache[m]?(v=a.domCache[m]).f7VirtualListIndex=m:(a.renderItem?a.tempDomElement.innerHTML=a.renderItem(o[h],m).trim():a.tempDomElement.innerHTML=o[h].toString().trim(),v=a.tempDomElement.childNodes[0],a.params.cache&&(a.domCache[m]=v),v.f7VirtualListIndex=m),h===i&&(s=a.dynamicHeight?l:h*a.params.height/a.params.cols),a.params.renderExternal||(v.style.top=s+"px",a.emit("local::itemBeforeInsert vlItemBeforeInsert",a,v,o[h]),a.fragment.appendChild(v))}a.updatableScroll||(a.dynamicHeight?a.itemsWrapEl.style.height=p+"px":a.itemsWrapEl.style.height=h*a.params.height/a.params.cols+"px"),a.params.renderExternal?o&&0===o.length&&(a.reachEnd=!0):(a.emit("local::beforeClear vlBeforeClear",a,a.fragment),a.itemsWrapEl.innerHTML="",a.emit("local::itemsBeforeInsert vlItemsBeforeInsert",a,a.fragment),o&&0===o.length?(a.reachEnd=!0,a.params.emptyTemplate&&(a.itemsWrapEl.innerHTML=a.params.emptyTemplate)):a.itemsWrapEl.appendChild(a.fragment),a.emit("local::itemsAfterInsert vlItemsAfterInsert",a,a.fragment)),void 0!==t&&e&&a.$scrollableParentEl.scrollTop(t,0),a.params.renderExternal&&a.params.renderExternal(a,{fromIndex:i,toIndex:n,listHeight:a.listHeight,topPosition:s,items:f})}},t.prototype.filterItems=function(e,t){void 0===t&&(t=!0);var a=this;a.filteredItems=[];for(var r=0;r<e.length;r+=1)a.filteredItems.push(a.items[e[r]]);t&&(a.$scrollableParentEl[0].scrollTop=0),a.update()},t.prototype.resetFilter=function(){var e=this;e.params.showFilteredItemsOnly?e.filteredItems=[]:(e.filteredItems=null,delete e.filteredItems),e.update()},t.prototype.scrollToItem=function(e){var t=this;if(e>t.items.length)return!1;var a=0;if(t.dynamicHeight)for(var r=0;r<e;r+=1)a+=t.heights[r];else a=e*t.params.height;var i=t.$el[0].offsetTop;return t.render(!0,i+a-parseInt(t.$scrollableParentEl.css("padding-top"),10)),!0},t.prototype.handleScroll=function(){this.render()},t.prototype.isVisible=function(){return!!(this.el.offsetWidth||this.el.offsetHeight||this.el.getClientRects().length)},t.prototype.handleResize=function(){this.isVisible()&&(this.setListSize(),this.render(!0))},t.prototype.appendItems=function(e){for(var t=0;t<e.length;t+=1)this.items.push(e[t]);this.update()},t.prototype.appendItem=function(e){this.appendItems([e])},t.prototype.replaceAllItems=function(e){this.items=e,delete this.filteredItems,this.domCache={},this.update()},t.prototype.replaceItem=function(e,t){this.items[e]=t,this.params.cache&&delete this.domCache[e],this.update()},t.prototype.prependItems=function(e){for(var t=this,a=e.length-1;a>=0;a-=1)t.items.unshift(e[a]);if(t.params.cache){var r={};Object.keys(t.domCache).forEach(function(a){r[parseInt(a,10)+e.length]=t.domCache[a]}),t.domCache=r}t.update()},t.prototype.prependItem=function(e){this.prependItems([e])},t.prototype.moveItem=function(e,t){var a=this,r=e,i=t;if(r!==i){var n=a.items.splice(r,1)[0];if(i>=a.items.length?(a.items.push(n),i=a.items.length-1):a.items.splice(i,0,n),a.params.cache){var s={};Object.keys(a.domCache).forEach(function(e){var t=parseInt(e,10),n=r<i?r:i,o=r<i?i:r,l=r<i?-1:1;(t<n||t>o)&&(s[t]=a.domCache[t]),t===n&&(s[o]=a.domCache[t]),t>n&&t<=o&&(s[t+l]=a.domCache[t])}),a.domCache=s}a.update()}},t.prototype.insertItemBefore=function(e,t){var a=this;if(0!==e)if(e>=a.items.length)a.appendItem(t);else{if(a.items.splice(e,0,t),a.params.cache){var r={};Object.keys(a.domCache).forEach(function(t){var i=parseInt(t,10);i>=e&&(r[i+1]=a.domCache[i])}),a.domCache=r}a.update()}else a.prependItem(t)},t.prototype.deleteItems=function(e){for(var t,a=this,r=0,i=function(i){var n=e[i];void 0!==t&&n>t&&(r=-i),n+=r,t=e[i];var s=a.items.splice(n,1)[0];if(a.filteredItems&&a.filteredItems.indexOf(s)>=0&&a.filteredItems.splice(a.filteredItems.indexOf(s),1),a.params.cache){var o={};Object.keys(a.domCache).forEach(function(e){var t=parseInt(e,10);t===n?delete a.domCache[n]:parseInt(e,10)>n?o[t-1]=a.domCache[e]:o[t]=a.domCache[e]}),a.domCache=o}},n=0;n<e.length;n+=1)i(n);a.update()},t.prototype.deleteAllItems=function(){var e=this;e.items=[],delete e.filteredItems,e.params.cache&&(e.domCache={}),e.update()},t.prototype.deleteItem=function(e){this.deleteItems([e])},t.prototype.clearCache=function(){this.domCache={}},t.prototype.update=function(e){e&&this.params.cache&&(this.domCache={}),this.setListSize(),this.render(!0)},t.prototype.init=function(){this.attachEvents(),this.setListSize(),this.render()},t.prototype.destroy=function(){var e=this;e.detachEvents(),e.$el[0].f7VirtualList=null,delete e.$el[0].f7VirtualList,Utils.deleteProps(e),e=null},t}(Framework7Class),VirtualList$1={name:"virtualList",static:{VirtualList:VirtualList},create:function(){this.virtualList=ConstructorMethods({defaultSelector:".virtual-list",constructor:VirtualList,app:this,domProp:"f7VirtualList"})}},ListIndex=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i,n,s,o=this,l={el:null,listEl:null,indexes:"auto",iosItemHeight:14,mdItemHeight:14,auroraItemHeight:14,scrollList:!0,label:!1,renderItem:function(e,t){return("\n          <li>"+e+"</li>\n        ").trim()},renderSkipPlaceholder:function(){return'<li class="list-index-skip-placeholder"></li>'},on:{}};if(o.useModulesParams(l),o.params=Utils.extend(l,a),!o.params.el)return o;if((r=$(o.params.el))[0].f7ListIndex)return r[0].f7ListIndex;if(0===(s=r.find("ul")).length&&(s=$("<ul></ul>"),r.append(s)),o.params.listEl&&(i=$(o.params.listEl)),"auto"===o.params.indexes&&!i)return o;function p(){var e={index:o};o.calcSize(),e!==o.height&&o.render()}function c(e){var t=$(e.target).closest("li");if(t.length){var a=t.index();if(o.skipRate>0){var r=a/(t.siblings("li").length-1);a=Math.round((o.indexes.length-1)*r)}var i=o.indexes[a];o.$el.trigger("listindex:click",i,a),o.emit("local::click listIndexClick",o,i,a),o.$el.trigger("listindex:select",i,a),o.emit("local::select listIndexSelect",o,i,a),o.$listEl&&o.params.scrollList&&o.scrollListToIndex(i,a)}}i?n=i.parents(".page-content").eq(0):0===(n=r.siblings(".page-content").eq(0)).length&&(n=r.parents(".page").eq(0).find(".page-content").eq(0)),r[0].f7ListIndex=o,Utils.extend(o,{app:t,$el:r,el:r&&r[0],$ul:s,ul:s&&s[0],$listEl:i,listEl:i&&i[0],$pageContentEl:n,pageContentEl:n&&n[0],indexes:a.indexes,height:0,skipRate:0}),o.useModules();var d,u,h,f,v,m={},g=null;function b(e){var t=s.children();t.length&&(h=t[0].getBoundingClientRect().top,f=t[t.length-1].getBoundingClientRect().top+t[0].offsetHeight,m.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,m.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,d=!0,u=!1,g=null)}function y(e){if(d){!u&&o.params.label&&(v=$('<span class="list-index-label"></span>'),r.append(v)),u=!0;var t="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;e.preventDefault();var a=(t-h)/(f-h);a=Math.min(Math.max(a,0),1);var i=Math.round((o.indexes.length-1)*a),n=o.indexes[i],s=f-h,l=(o.height-s)/2+(1-a)*s;i!==g&&(o.params.label&&v.html(n).transform("translateY(-"+l+"px)"),o.$listEl&&o.params.scrollList&&o.scrollListToIndex(n,i)),g=i,o.$el.trigger("listindex:select",o),o.emit("local::select listIndexSelect",o,n,i)}}function w(){d&&(d=!1,u=!1,o.params.label&&(v&&v.remove(),v=void 0))}var C=!!t.support.passiveListener&&{passive:!0};return o.attachEvents=function(){r.parents(".tab").on("tab:show",p),r.parents(".page").on("page:reinit",p),r.parents(".panel").on("panel:open",p),r.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast").on("modal:open",p),t.on("resize",p),r.on("click",c),r.on(t.touchEvents.start,b,C),t.on("touchmove:active",y),t.on("touchend:passive",w)},o.detachEvents=function(){r.parents(".tab").off("tab:show",p),r.parents(".page").off("page:reinit",p),r.parents(".panel").off("panel:open",p),r.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast").off("modal:open",p),t.off("resize",p),r.off("click",c),r.off(t.touchEvents.start,b,C),t.off("touchmove:active",y),t.off("touchend:passive",w)},o.init(),o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.scrollListToIndex=function(e,t){var a,r=this.$listEl,i=this.$pageContentEl,n=this.app;if(!r||!i||0===i.length)return this;if(r.find(".list-group-title, .item-divider").each(function(t,r){if(!a){var i=$(r);i.text()===e&&(a=i)}}),!a||0===a.length)return this;var s=a.parent().offset().top,o=parseInt(i.css("padding-top"),10),l=i[0].scrollTop,p=a.offset().top;if(i.parents(".page-with-navbar-large").length){var c=$(n.navbar.getElByPage(i.parents(".page-with-navbar-large").eq(0))).find(".title-large");c.length&&(o-=c[0].offsetHeight||0)}return s<=o?i.scrollTop(s+l-o):i.scrollTop(p+l-o),this},t.prototype.renderSkipPlaceholder=function(){return this.params.renderSkipPlaceholder.call(this)},t.prototype.renderItem=function(e,t){return this.params.renderItem.call(this,e,t)},t.prototype.render=function(){var e,t=this,a=t.$ul,r=t.indexes,i=t.skipRate,n=r.map(function(a,r){if(r%i!=0&&i>0)return e=!0,"";var n=t.renderItem(a,r);return e&&(n=t.renderSkipPlaceholder()+n),e=!1,n}).join("");return a.html(n),t},t.prototype.calcSize=function(){var e=this.app,t=this.params,a=this.el,r=this.indexes,i=a.offsetHeight,n=t[e.theme+"ItemHeight"],s=Math.floor(i/n),o=r.length,l=0;return o>s&&(l=Math.ceil((2*o-1)/s)),this.height=i,this.skipRate=l,this},t.prototype.calcIndexes=function(){var e=this;return"auto"===e.params.indexes?(e.indexes=[],e.$listEl.find(".list-group-title, .item-divider").each(function(t,a){var r=$(a).text();e.indexes.indexOf(r)<0&&e.indexes.push(r)})):e.indexes=e.params.indexes,e},t.prototype.update=function(){return this.calcIndexes(),this.calcSize(),this.render(),this},t.prototype.init=function(){this.calcIndexes(),this.calcSize(),this.render(),this.attachEvents()},t.prototype.destroy=function(){var e=this;e.$el.trigger("listindex:beforedestroy",e),e.emit("local::beforeDestroy listIndexBeforeDestroy",e),e.detachEvents(),e.$el[0]&&(e.$el[0].f7ListIndex=null,delete e.$el[0].f7ListIndex),Utils.deleteProps(e),e=null},t}(Framework7Class),ListIndex$1={name:"listIndex",static:{ListIndex:ListIndex},create:function(){this.listIndex=ConstructorMethods({defaultSelector:".list-index",constructor:ListIndex,app:this,domProp:"f7ListIndex"})},on:{tabMounted:function(e){var t=this;$(e).find(".list-index-init").each(function(e,a){var r=Utils.extend($(a).dataset(),{el:a});t.listIndex.create(r)})},tabBeforeRemove:function(e){$(e).find(".list-index-init").each(function(e,t){t.f7ListIndex&&t.f7ListIndex.destroy()})},pageInit:function(e){var t=this;e.$el.find(".list-index-init").each(function(e,a){var r=Utils.extend($(a).dataset(),{el:a});t.listIndex.create(r)})},pageBeforeRemove:function(e){e.$el.find(".list-index-init").each(function(e,t){t.f7ListIndex&&t.f7ListIndex.destroy()})}},vnode:{"list-index-init":{insert:function(e){var t=e.elm,a=Utils.extend($(t).dataset(),{el:t});this.listIndex.create(a)},destroy:function(e){var t=e.elm;t.f7ListIndex&&t.f7ListIndex.destroy()}}}},Timeline={name:"timeline"},Tab={show:function(){for(var e,t,a,r=[],i=arguments.length;i--;)r[i]=arguments[i];var n,s,o,l,p=this;1===r.length&&r[0].constructor===Object?(n=r[0].tabEl,s=r[0].tabLinkEl,o=r[0].animate,l=r[0].tabRoute):(n=(e=r)[0],s=e[1],o=e[2],l=e[3],"boolean"==typeof r[1]&&(n=(t=r)[0],o=t[1],s=t[2],l=t[3],r.length>2&&s.constructor===Object&&(n=(a=r)[0],o=a[1],l=a[2],s=a[3]))),void 0===o&&(o=!0);var c,d=$(n);if(l&&d[0]&&(d[0].f7TabRoute=l),0===d.length||d.hasClass("tab-active"))return{$newTabEl:d,newTabEl:d[0]};s&&(c=$(s));var u=d.parent(".tabs");if(0===u.length)return{$newTabEl:d,newTabEl:d[0]};p.swipeout&&(p.swipeout.allowOpen=!0);var h=[];function f(){h.forEach(function(e){e()})}var v,m=!1;if(u.parent().hasClass("tabs-animated-wrap")){u.parent()[o?"removeClass":"addClass"]("not-animated");var g=parseFloat(u.css("transition-duration").replace(",","."));o&&g&&(u.transitionEnd(f),m=!0);var b=100*(p.rtl?d.index():-d.index());u.transform("translate3d("+b+"%,0,0)")}u.parent().hasClass("tabs-swipeable-wrap")&&p.swiper&&((v=u.parent()[0].swiper)&&v.activeIndex!==d.index()?(m=!0,v.once("slideChangeTransitionEnd",function(){f()}).slideTo(d.index(),o?void 0:0)):v&&v.animating&&(m=!0,v.once("slideChangeTransitionEnd",function(){f()})));var y=u.children(".tab-active");if(y.removeClass("tab-active"),(!v||v&&!v.animating||v&&l)&&(y.trigger("tab:hide"),p.emit("tabHide",y[0])),d.addClass("tab-active"),(!v||v&&!v.animating||v&&l)&&(d.trigger("tab:show"),p.emit("tabShow",d[0])),!c&&((!(c=$("string"==typeof n?'.tab-link[href="'+n+'"]':'.tab-link[href="#'+d.attr("id")+'"]'))||c&&0===c.length)&&$("[data-tab]").each(function(e,t){d.is($(t).attr("data-tab"))&&(c=$(t))}),l&&(!c||c&&0===c.length)&&0===(c=$('[data-route-tab-id="'+l.route.tab.id+'"]')).length&&(c=$('.tab-link[href="'+l.url+'"]')),c.length>1&&d.parents(".page").length&&(c=c.filter(function(e,t){return $(t).parents(".page")[0]===d.parents(".page")[0]}),"ios"===p.theme&&0===c.length&&l))){var w=d.parents(".page"),C=$(p.navbar.getElByPage(w));0===(c=C.find('[data-route-tab-id="'+l.route.tab.id+'"]')).length&&(c=C.find('.tab-link[href="'+l.url+'"]'))}if(c.length>0){var x;if(y&&y.length>0){var k=y.attr("id");k&&(!(x=$('.tab-link[href="#'+k+'"]'))||x&&0===x.length)&&(x=$('.tab-link[data-route-tab-id="'+k+'"]')),(!x||x&&0===x.length)&&$("[data-tab]").each(function(e,t){y.is($(t).attr("data-tab"))&&(x=$(t))}),(!x||x&&0===x.length)&&(x=c.siblings(".tab-link-active"))}else l&&(x=c.siblings(".tab-link-active"));if(x&&x.length>1&&y&&y.parents(".page").length&&(x=x.filter(function(e,t){return $(t).parents(".page")[0]===y.parents(".page")[0]})),x&&x.length>0&&x.removeClass("tab-link-active"),c&&c.length>0&&(c.addClass("tab-link-active"),"md"===p.theme&&p.toolbar)){var E=c.parents(".tabbar, .tabbar-labels");E.length>0&&p.toolbar.setHighlight(E)}}return{$newTabEl:d,newTabEl:d[0],$oldTabEl:y,oldTabEl:y[0],onTabsChanged:function(e){h.push(e)},animated:m}}},Tabs={name:"tabs",create:function(){Utils.extend(this,{tab:{show:Tab.show.bind(this)}})},clicks:{".tab-link":function(e,t){void 0===t&&(t={});(e.attr("href")&&0===e.attr("href").indexOf("#")||e.attr("data-tab"))&&this.tab.show({tabEl:t.tab||e.attr("href"),tabLinkEl:e,animate:t.animate})}}};function swipePanel(e){var t=e.app;Utils.extend(e,{swipeable:!0,swipeInitialized:!0});var a,r,i,n,s,o,l,p,c,d,u,h=t.params.panel,f=e.$el,v=e.$backdropEl,m=e.side,g=e.effect,b={},y=0;function w(o){if(e.swipeable&&t.panel.allowOpen&&(h.swipe||h.swipeOnlyClose)&&!r&&!($(".modal-in:not(.toast):not(.notification), .photo-browser-in").length>0)&&(a=t.panel["left"===m?"right":"left"]||{},(e.opened||!a.opened)&&(h.swipeCloseOpposite||h.swipeOnlyClose||!a.opened)&&(!o.target||"input"!==o.target.nodeName.toLowerCase()||"range"!==o.target.type)&&!($(o.target).closest(".range-slider, .tabs-swipeable-wrap, .calendar-months, .no-swipe-panel, .card-opened").length>0)&&(b.x="touchstart"===o.type?o.targetTouches[0].pageX:o.pageX,b.y="touchstart"===o.type?o.targetTouches[0].pageY:o.pageY,(!h.swipeOnlyClose||e.opened)&&("both"===h.swipe||!h.swipeCloseOpposite||h.swipe===m||e.opened)))){if(h.swipeActiveArea&&!e.opened){if("left"===m&&b.x>h.swipeActiveArea)return;if("right"===m&&b.x<t.width-h.swipeActiveArea)return}if(h.swipeCloseActiveAreaSide&&e.opened){if("left"===m&&b.x<f[0].offsetWidth-h.swipeCloseActiveAreaSide)return;if("right"===m&&b.x>t.width-f[0].offsetWidth+h.swipeCloseActiveAreaSide)return}y=0,u=$(e.getViewEl()),i=!1,r=!0,n=void 0,s=Utils.now(),d=void 0}}function C(a){if(r&&!((y+=1)<2))if(a.f7PreventSwipePanel||t.preventSwipePanelBySwipeBack||t.preventSwipePanel)r=!1;else{var w="touchmove"===a.type?a.targetTouches[0].pageX:a.pageX,C="touchmove"===a.type?a.targetTouches[0].pageY:a.pageY;if(void 0===n&&(n=!!(n||Math.abs(C-b.y)>Math.abs(w-b.x))),n)r=!1;else{if(!d){if(d=w>b.x?"to-right":"to-left","both"===h.swipe&&h.swipeActiveArea>0&&!e.opened){if("left"===m&&b.x>h.swipeActiveArea)return void(r=!1);if("right"===m&&b.x<t.width-h.swipeActiveArea)return void(r=!1)}if(f.hasClass("panel-visible-by-breakpoint"))return void(r=!1);if("left"===m&&"to-left"===d&&!f.hasClass("panel-active")||"right"===m&&"to-right"===d&&!f.hasClass("panel-active"))return void(r=!1)}var x=e.opened?0:-h.swipeThreshold;if("right"===m&&(x=-x),h.swipeNoFollow){var $,k=w-b.x,E=(new Date).getTime()-s;return!e.opened&&("left"===m&&k>-x||"right"===m&&-k>x)&&($=!0),e.opened&&("left"===m&&k<0||"right"===m&&k>0)&&($=!0),void($&&(E<300&&("to-left"===d&&("right"===m&&t.panel.open(m),"left"===m&&f.hasClass("panel-active")&&t.panel.close()),"to-right"===d&&("left"===m&&t.panel.open(m),"right"===m&&f.hasClass("panel-active")&&t.panel.close())),r=!1,i=!1))}i||(e.opened||(f.css("display","block"),v.css("display","block"),f.trigger("panel:swipeopen",e),e.emit("local::swipeOpen panelSwipeOpen",e)),c=f[0].offsetWidth,f.transition(0)),i=!0,a.preventDefault(),o=w-b.x+x,"right"===m?"cover"===g?((l=o+(e.opened?0:c))<0&&(l=0),l>c&&(l=c)):((l=o-(e.opened?c:0))>0&&(l=0),l<-c&&(l=-c)):((l=o+(e.opened?c:0))<0&&(l=0),l>c&&(l=c)),"reveal"===g?(u.transform("translate3d("+l+"px,0,0)").transition(0),v.transform("translate3d("+l+"px,0,0)").transition(0),f.trigger("panel:swipe",e,Math.abs(l/c)),e.emit("local::swipe panelSwipe",e,Math.abs(l/c))):("left"===m&&(l-=c),f.transform("translate3d("+l+"px,0,0)").transition(0),v.transition(0),p=1-Math.abs(l/c),v.css({opacity:p}),f.trigger("panel:swipe",e,Math.abs(l/c)),e.emit("local::swipe panelSwipe",e,Math.abs(l/c)))}}}function x(){if(!r||!i)return r=!1,void(i=!1);r=!1,i=!1;var t,a=(new Date).getTime()-s,n=0===l||Math.abs(l)===c,p=h.swipeThreshold||0;if("swap"===(t=e.opened?"cover"===g?0===l?"reset":a<300&&Math.abs(l)>0?"swap":a>=300&&Math.abs(l)<c/2?"reset":"swap":l===-c?"reset":a<300&&Math.abs(l)>=0||a>=300&&Math.abs(l)<=c/2?"left"===m&&l===c?"reset":"swap":"reset":Math.abs(o)<p?"reset":"cover"===g?0===l?"swap":a<300&&Math.abs(l)>0?"swap":a>=300&&Math.abs(l)<c/2?"swap":"reset":0===l?"reset":a<300&&Math.abs(l)>0||a>=300&&Math.abs(l)>=c/2?"swap":"reset")&&(e.opened?e.close(!n):e.open(!n)),"reset"===t&&!e.opened)if(n)f.css({display:""});else{var d="reveal"===g?u:f;$("html").addClass("with-panel-transitioning"),d.transitionEnd(function(){f.hasClass("panel-active")||(f.css({display:""}),$("html").removeClass("with-panel-transitioning"))})}"reveal"===g&&Utils.nextFrame(function(){u.transition(""),u.transform("")}),f.transition("").transform(""),v.css({display:""}).transform("").transition("").css("opacity","")}t.on("touchstart:passive",w),t.on("touchmove:active",C),t.on("touchend:passive",x),e.on("panelDestroy",function(){t.off("touchstart:passive",w),t.off("touchmove:active",C),t.off("touchend:passive",x)})}function resizablePanel(e){var t=e.app;Utils.extend(e,{resizable:!0,resizableWidth:null,resizableInitialized:!0});var a=$("html"),r=e.$el,i=e.$backdropEl,n=e.side,s=e.effect;if(r){var o,l,p,c,d,u,h,f,v={};0===e.$el.find(".panel-resize-handler").length&&e.$el.append('<div class="panel-resize-handler"></div>'),e.$resizeHandlerEl=e.$el.children(".panel-resize-handler"),r.addClass("panel-resizable");var m=!!Support.passiveListener&&{passive:!0};e.$el.on(t.touchEvents.start,".panel-resize-handler",b,m),t.on("touchmove:active",y),t.on("touchend:passive",w),t.on("resize",C),e.on("beforeOpen",C),e.once("panelDestroy",function(){r.removeClass("panel-resizable"),e.$resizeHandlerEl.remove(),e.$el.off(t.touchEvents.start,".panel-resize-handler",b,m),t.off("touchmove:active",y),t.off("touchend:passive",w),t.off("resize",C),e.off("beforeOpen",C)})}function g(e){if(!e)return null;if(e.indexOf("%")>=0||e.indexOf("vw")>=0)return parseInt(e,10)/100*t.width;var a=parseInt(e,10);return Number.isNaN(a)?null:a}function b(t){e.resizable&&r.hasClass("panel-resizable")&&(v.x="touchstart"===t.type?t.targetTouches[0].pageX:t.pageX,v.y="touchstart"===t.type?t.targetTouches[0].pageY:t.pageY,l=!1,o=!0,u=g(r.css("min-width")),h=g(r.css("max-width")),f=r.hasClass("panel-visible-by-breakpoint"))}function y(m){if(o){var g="touchmove"===m.type?m.targetTouches[0].pageX:m.pageX;l||(c=r[0].offsetWidth,r.transition(0),r.addClass("panel-resizing"),a.css("cursor","col-resize"),("reveal"===s||f)&&(d=$(e.getViewEl())),"reveal"!==s||f||(i.transition(0),d.transition(0))),l=!0,m.preventDefault(),p=g-v.x;var b="left"===n?c+p:c-p;u&&!Number.isNaN(u)&&(b=Math.max(b,u)),h&&!Number.isNaN(h)&&(b=Math.min(b,h)),b=Math.min(Math.max(b,0),t.width),e.resizableWidth=b,r[0].style.width=b+"px","reveal"!==s||f?f&&d&&d.css("margin-"+n,b+"px"):(d&&d.transform("translate3d("+("left"===n?b:-b)+"px, 0, 0)"),i&&i.transform("translate3d("+("left"===n?b:-b)+"px, 0, 0)")),r.trigger("panel:resize",e,b),e.emit("local::resize panelResize",e,b)}}function w(){if($("html").css("cursor",""),!o||!l)return o=!1,void(l=!1);o=!1,l=!1,a[0].style.setProperty("--f7-panel-"+n+"-width",e.resizableWidth+"px"),r[0].style.width="","reveal"!==s||f||(d.transform(""),i.transform("")),r.removeClass("panel-resizing"),Utils.nextFrame(function(){f||(r.transition(""),"reveal"===s&&(i.transition(""),d&&d.transition("")))})}function C(){e.opened&&e.resizableWidth&&(u=g(r.css("min-width")),h=g(r.css("max-width")),u&&!Number.isNaN(u)&&e.resizableWidth<u&&(e.resizableWidth=Math.max(e.resizableWidth,u)),h&&!Number.isNaN(h)&&e.resizableWidth>h&&(e.resizableWidth=Math.min(e.resizableWidth,h)),e.resizableWidth=Math.min(Math.max(e.resizableWidth,0),t.width),a[0].style.setProperty("--f7-panel-"+n+"-width",e.resizableWidth+"px"))}}var Panel=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=a.el;!r&&a.content&&(r=a.content);var i=$(r);if(0===i.length)return this;if(i[0].f7Panel)return i[0].f7Panel;i[0].f7Panel=this;var n=a.opened,s=a.side,o=a.effect;if(void 0===n&&(n=i.hasClass("panel-active")),void 0===s&&(s=i.hasClass("panel-left")?"left":"right"),void 0===o&&(o=i.hasClass("panel-cover")?"cover":"reveal"),t.panel[s])throw new Error("Framework7: Can't create panel; app already has a "+s+" panel!");t.panel[s]=this;var l=$(".panel-backdrop");return 0===l.length&&(l=$('<div class="panel-backdrop"></div>')).insertBefore(i),Utils.extend(this,{app:t,side:s,effect:o,$el:i,el:i[0],opened:n,$backdropEl:l,backdropEl:l[0],params:a}),this.useModules(),this.init(),this}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.getViewEl=function(){var e=this.app;return e.root.children(".views").length>0?e.root.children(".views")[0]:e.root.children(".view")[0]},t.prototype.setBreakpoint=function(e){var t,a,r;void 0===e&&(e=!0);var i=this.app,n=this.side,s=this.$el,o=$(this.getViewEl()),l=i.params.panel[n+"Breakpoint"],p=s.hasClass("panel-visible-by-breakpoint");i.width>=l?p?o.css(((a={})["margin-"+n]=s.width()+"px",a)):($("html").removeClass("with-panel-"+n+"-reveal with-panel-"+n+"-cover with-panel"),s.css("display","").addClass("panel-visible-by-breakpoint").removeClass("panel-active"),this.onOpen(),this.onOpened(),o.css(((t={})["margin-"+n]=s.width()+"px",t)),i.allowPanelOpen=!0,e&&(this.emit("local::breakpoint panelBreakpoint"),this.$el.trigger("panel:breakpoint",this))):p&&(s.css("display","").removeClass("panel-visible-by-breakpoint panel-active"),this.onClose(),this.onClosed(),o.css(((r={})["margin-"+n]="",r)),e&&(this.emit("local::breakpoint panelBreakpoint"),this.$el.trigger("panel:breakpoint",this)))},t.prototype.initBreakpoints=function(){var e=this,t=e.app;return e.resizeHandler=function(){e.setBreakpoint()},t.params.panel[e.side+"Breakpoint"]&&t.on("resize",e.resizeHandler),e.setBreakpoint(),e},t.prototype.initSwipePanel=function(){swipePanel(this)},t.prototype.initResizablePanel=function(){resizablePanel(this)},t.prototype.toggle=function(e){void 0===e&&(e=!0);this.opened?this.close(e):this.open(e)},t.prototype.onOpen=function(){this.opened=!0,this.$el.trigger("panel:beforeopen",this),this.emit("local::beforeOpen panelBeforeOpen",this),this.$el.trigger("panel:open",this),this.emit("local::open panelOpen",this)},t.prototype.onOpened=function(){this.app.panel.allowOpen=!0,this.$el.trigger("panel:opened",this),this.emit("local::opened panelOpened",this)},t.prototype.onClose=function(){this.opened=!1,this.$el.addClass("panel-closing"),this.$el.trigger("panel:beforeclose",this),this.emit("local::beforeClose panelBeforeClose",this),this.$el.trigger("panel:close",this),this.emit("local::close panelClose",this)},t.prototype.onClosed=function(){this.app.panel.allowOpen=!0,this.$el.removeClass("panel-closing"),this.$el.trigger("panel:closed",this),this.emit("local::closed panelClosed",this)},t.prototype.open=function(e){void 0===e&&(e=!0);var t=this,a=t.app;if(!a.panel.allowOpen)return!1;var r=t.side,i=t.effect,n=t.$el,s=t.$backdropEl,o=t.opened,l=n.parent(),p=n.parents(document).length>0;if(!l.is(a.root)||n.prevAll(".views, .view").length){var c=a.root.children(".panel, .views, .view").eq(0),d=a.root.children(".statusbar").eq(0);c.length?n.insertBefore(c):d.length?n.insertAfter(c):a.root.prepend(n),s&&s.length&&(!s.parent().is(a.root)&&0===s.nextAll(".panel").length||s.parent().is(a.root)&&0===s.nextAll(".panel").length)&&s.insertBefore(n),t.once("panelClosed",function(){p?l.append(n):n.remove()})}if(o||n.hasClass("panel-visible-by-breakpoint")||n.hasClass("panel-active"))return!1;a.panel.close("left"===r?"right":"left",e),a.panel.allowOpen=!1,n[e?"removeClass":"addClass"]("not-animated"),n.css({display:"block"}).addClass("panel-active"),s[e?"removeClass":"addClass"]("not-animated"),s.css({display:"block"});var u="reveal"===i?n.nextAll(".view, .views").eq(0):n;return e?Utils.nextFrame(function(){$("html").addClass("with-panel with-panel-"+r+"-"+i),t.onOpen(),function e(){u.transitionEnd(function(a){$(a.target).is(u)?n.hasClass("panel-active")?(t.onOpened(),s.css({display:""})):(t.onClosed(),s.css({display:""})):e()})}()}):($("html").addClass("with-panel with-panel-"+r+"-"+i),t.onOpen(),t.onOpened(),s.css({display:""})),!0},t.prototype.close=function(e){void 0===e&&(e=!0);var t=this,a=t.app,r=t.side,i=t.effect,n=t.$el,s=t.$backdropEl;if(!t.opened||n.hasClass("panel-visible-by-breakpoint")||!n.hasClass("panel-active"))return!1;n[e?"removeClass":"addClass"]("not-animated"),n.removeClass("panel-active"),s[e?"removeClass":"addClass"]("not-animated");var o="reveal"===i?n.nextAll(".view, .views").eq(0):n;return t.onClose(),a.panel.allowOpen=!1,e?(o.transitionEnd(function(){n.hasClass("panel-active")||(n.css({display:""}),$("html").removeClass("with-panel-transitioning"),t.onClosed())}),$("html").removeClass("with-panel with-panel-"+r+"-"+i).addClass("with-panel-transitioning")):(n.css({display:""}),n.removeClass("not-animated"),$("html").removeClass("with-panel with-panel-transitioning with-panel-"+r+"-"+i),t.onClosed()),!0},t.prototype.init=function(){var e=this.app;e.params.panel[this.side+"Breakpoint"]&&this.initBreakpoints(),(e.params.panel.swipe===this.side||"both"===e.params.panel.swipe||e.params.panel.swipe&&e.params.panel.swipe!==this.side&&e.params.panel.swipeCloseOpposite)&&this.initSwipePanel(),(this.params.resizable||this.$el.hasClass("panel-resizable"))&&this.initResizablePanel()},t.prototype.destroy=function(){var e,t=this,a=t.app;if(t.$el){if(t.emit("local::beforeDestroy panelBeforeDestroy",t),t.$el.trigger("panel:beforedestroy",t),t.resizeHandler&&a.off("resize",t.resizeHandler),t.$el.hasClass("panel-visible-by-breakpoint")){var r=$(t.getViewEl());t.$el.css("display","").removeClass("panel-visible-by-breakpoint panel-active"),r.css(((e={})["margin-"+t.side]="",e)),t.emit("local::breakpoint panelBreakpoint"),t.$el.trigger("panel:breakpoint",t)}t.$el.trigger("panel:destroy",t),t.emit("local::destroy panelDestroy"),delete a.panel[t.side],t.el&&(t.el.f7Panel=null,delete t.el.f7Panel),Utils.deleteProps(t),t=null}},t}(Framework7Class),Panel$1={name:"panel",params:{panel:{leftBreakpoint:0,rightBreakpoint:0,swipe:void 0,swipeActiveArea:0,swipeCloseActiveAreaSide:0,swipeCloseOpposite:!0,swipeOnlyClose:!1,swipeNoFollow:!1,swipeThreshold:0,closeByBackdropClick:!0}},static:{Panel:Panel},instance:{panel:{allowOpen:!0}},create:function(){var e=this;Utils.extend(e.panel,{disableResizable:function(t){var a;void 0===t&&(t="both");var r=[];"string"==typeof t?"both"===t?(a="both",r=[e.panel.left,e.panel.right]):(a=t,r.push(e.panel[a])):r=[t],r.forEach(function(e){e.resizable=!1,e.$el.removeClass("panel-resizable")})},enableResizable:function(t){var a;void 0===t&&(t="both");var r=[];"string"==typeof t?"both"===t?(a="both",r=[e.panel.left,e.panel.right]):(a=t,r.push(e.panel[a])):r=[t],r.forEach(function(e){e&&(e.resizableInitialized?(e.resizable=!0,e.$el.addClass("panel-resizable")):e.initResizablePanel())})},disableSwipe:function(t){var a;void 0===t&&(t="both");var r=[];"string"==typeof t?"both"===t?(a="both",r=[e.panel.left,e.panel.right]):(a=t,r.push(e.panel[a])):r=[t],r.forEach(function(e){e.swipeable=!1})},enableSwipe:function(t){void 0===t&&(t="both");var a,r=[];"string"==typeof t?(a=t,"left"===e.params.panel.swipe&&"right"===a||"right"===e.params.panel.swipe&&"left"===a||"both"===a?(a="both",e.params.panel.swipe=a,r=[e.panel.left,e.panel.right]):(e.params.panel.swipe=a,r.push(e.panel[a]))):t&&r.push(t),r.forEach(function(e){e&&(e.swipeInitialized?e.swipeable=!0:e.initSwipePanel())})},create:function(t){return new Panel(e,t)},open:function(t,a){var r=t;if(!r){if($(".panel").length>1)return!1;r=$(".panel").hasClass("panel-left")?"left":"right"}if(!r)return!1;if(e.panel[r])return e.panel[r].open(a);var i=$(".panel-"+r);return i.length>0&&e.panel.create({el:i}).open(a)},close:function(t,a){var r,i;return i?r=$(".panel-"+(i=t)):i=(r=$(".panel.panel-active")).hasClass("panel-left")?"left":"right",!!i&&(e.panel[i]?e.panel[i].close(a):r.length>0&&e.panel.create({el:r}).close(a))},toggle:function(t,a){var r,i=t;if(t)r=$(".panel-"+(i=t));else if($(".panel.panel-active").length)i=(r=$(".panel.panel-active")).hasClass("panel-left")?"left":"right";else{if($(".panel").length>1)return!1;i=$(".panel").hasClass("panel-left")?"left":"right",r=$(".panel-"+i)}return!!i&&(e.panel[i]?e.panel[i].toggle(a):r.length>0&&e.panel.create({el:r}).toggle(a))},get:function(t){var a=t;if(!a){if($(".panel").length>1)return;a=$(".panel").hasClass("panel-left")?"left":"right"}if(a){if(e.panel[a])return e.panel[a];var r=$(".panel-"+a);return r.length>0?e.panel.create({el:r}):void 0}}})},on:{init:function(){var e=this;$(".panel").each(function(t,a){var r=$(a).hasClass("panel-left")?"left":"right";e.panel[r]=e.panel.create({el:a,side:r})})}},clicks:{".panel-open":function(e,t){void 0===t&&(t={});var a="left";("right"===t.panel||1===$(".panel").length&&$(".panel").hasClass("panel-right"))&&(a="right"),this.panel.open(a,t.animate)},".panel-close":function(e,t){void 0===t&&(t={});var a=t.panel;this.panel.close(a,t.animate)},".panel-toggle":function(e,t){void 0===t&&(t={});var a=t.panel;this.panel.toggle(a,t.animate)},".panel-backdrop":function(){var e=$(".panel-active"),t=e[0]&&e[0].f7Panel;e.trigger("panel:backdrop-click"),t&&t.emit("backdropClick",t),this.emit("panelBackdropClick",t||e[0]),this.params.panel.closeByBackdropClick&&this.panel.close()}}},CardExpandable={open:function(e,t){var a;void 0===e&&(e=".card-expandable"),void 0===t&&(t=!0);var r=this;if(!$(".card-opened").length){var i=$(e).eq(0);if(i&&i.length&&!(i.hasClass("card-opened")||i.hasClass("card-opening")||i.hasClass("card-closing"))){var n,s=i.parents(".page").eq(0);if(s.length)if(i.trigger("card:beforeopen",{prevent:_}),r.emit("cardBeforeOpen",i[0],_),!n){var o,l,p,c=Object.assign({animate:t},r.params.card,i.dataset()),d=i.parents(".page-content");i.attr("data-backdrop-el")&&(o=$(i.attr("data-backdrop-el"))),!o&&c.backdrop&&((o=d.find(".card-backdrop")).length||(o=$('<div class="card-backdrop"></div>'),d.append(o))),c.hideNavbarOnOpen&&((l=s.children(".navbar")).length||s[0].f7Page&&(l=s[0].f7Page.$navbarEl)),c.hideToolbarOnOpen&&((p=s.children(".toolbar")).length||(p=s.parents(".view").children(".toolbar")),p.length||(p=s.parents(".views").children(".toolbar")));var u,h=i.css("transform");h&&h.match(/[2-9]/)&&(u=!0);var f=i.children(".card-content"),v=$(document.createElement("div")).addClass("card-expandable-size");i.append(v);var m,g,b=i[0].offsetWidth,y=i[0].offsetHeight,w=s[0].offsetWidth,C=s[0].offsetHeight,x=v[0].offsetWidth||w,k=v[0].offsetHeight||C,E=x/b,S=k/y,T=i.offset(),M=s.offset();if(T.left-=M.left,u){var P=h.replace(/matrix\(|\)/g,"").split(",").map(function(e){return e.trim()});if(P&&P.length>1){var O=parseFloat(P[0]);m=T.left-b*(1-O)/2,g=T.top-M.top-y*(1-O)/2,r.rtl&&(m-=i[0].scrollLeft)}else m=i[0].offsetLeft,g=i[0].offsetTop-(d.length?d[0].scrollTop:0)}else m=T.left,g=T.top-M.top,r.rtl&&(m-=i[0].scrollLeft);g-=(C-k)/2;var D=x-b-(m-=(w-x)/2);r.rtl&&(m=(a=[D,m])[0],D=a[1]);var I,R,B,L,A,z,H,U,N,V,F,j=k-y-g,q=(D-m)/2,Y=(j-g)/2;c.hideNavbarOnOpen&&l&&l.length&&r.navbar.hide(l,c.animate),c.hideToolbarOnOpen&&p&&p.length&&r.toolbar.hide(p,c.animate),o&&o.removeClass("card-backdrop-out").addClass("card-backdrop-in"),i.removeClass("card-transitioning"),c.animate&&i.addClass("card-opening"),i.trigger("card:open"),r.emit("cardOpen",i[0]),f.css({width:x+"px",height:k+"px"}).transform("translate3d("+(r.rtl?m+q:-m-q)+"px, 0px, 0) scale("+1/E+", "+1/S+")"),i.transform("translate3d("+q+"px, "+Y+"px, 0) scale("+E+", "+S+")"),c.animate?i.transitionEnd(function(){W()}):W(),i[0].detachEventHandlers=function(){r.off("resize",X),Support.touch&&c.swipeToClose&&(r.off("touchstart:passive",G),r.off("touchmove:active",J),r.off("touchend:passive",Q))},r.on("resize",X),Support.touch&&c.swipeToClose&&(r.on("touchstart:passive",G),r.on("touchmove:active",J),r.on("touchend:passive",Q))}}}function _(){n=!0}function W(){s.addClass("page-with-card-opened"),r.device.ios&&d.length&&(d.css("height",d[0].offsetHeight+1+"px"),setTimeout(function(){d.css("height","")})),i.addClass("card-opened"),i.removeClass("card-opening"),i.trigger("card:opened"),r.emit("cardOpened",i[0],s[0])}function X(){var e;i.removeClass("card-transitioning"),b=i[0].offsetWidth,y=i[0].offsetHeight,w=s[0].offsetWidth,C=s[0].offsetHeight,x=v[0].offsetWidth||w,k=v[0].offsetHeight||C,E=x/b,S=k/y,i.transform("translate3d(0px, 0px, 0) scale(1)"),T=i.offset(),M=s.offset(),T.left-=M.left,T.top-=M.top,m=T.left-(w-x)/2,r.rtl&&(m-=i[0].scrollLeft),g=T.top-(C-k)/2,D=x-b-m,j=k-y-g,r.rtl&&(m=(e=[D,m])[0],D=e[1]),q=(D-m)/2,Y=(j-g)/2,i.transform("translate3d("+q+"px, "+Y+"px, 0) scale("+E+", "+S+")"),f.css({width:x+"px",height:k+"px"}).transform("translate3d("+(r.rtl?m+q:-m-q)+"px, 0px, 0) scale("+1/E+", "+1/S+")")}function G(e){$(e.target).closest(i).length&&i.hasClass("card-opened")&&(I=f.scrollTop(),R=!0,L=e.targetTouches[0].pageX,A=e.targetTouches[0].pageY,U=void 0,V=!1,F=!1)}function J(e){if(R){if(z=e.targetTouches[0].pageX,H=e.targetTouches[0].pageY,void 0===U&&(U=!!(U||Math.abs(H-A)>Math.abs(z-L))),F||V||(!U&&e.targetTouches[0].clientX<=50?F=!0:V=!0),!F&&!V||V&&0!==I)return R=!0,void(B=!0);B||i.removeClass("card-transitioning"),B=!0,((N=V?Math.max((H-A)/150,0):Math.max((z-L)/(b/2),0))>0&&V||F)&&(V&&r.device.ios&&(f.css("-webkit-overflow-scrolling","auto"),f.scrollTop(0)),e.preventDefault()),N>1&&(N=Math.pow(N,.3)),N>(V?1.3:1.1)?(R=!1,B=!1,r.card.close(i)):i.transform("translate3d("+q+"px, "+Y+"px, 0) scale("+E*(1-.2*N)+", "+S*(1-.2*N)+")")}}function Q(){R&&B&&(R=!1,B=!1,r.device.ios&&f.css("-webkit-overflow-scrolling",""),N>=.8?r.card.close(i):i.addClass("card-transitioning").transform("translate3d("+q+"px, "+Y+"px, 0) scale("+E+", "+S+")"))}},close:function(e,t){void 0===e&&(e=".card-expandable.card-opened"),void 0===t&&(t=!0);var a=this,r=$(e).eq(0);if(r&&r.length&&r.hasClass("card-opened")&&!r.hasClass("card-opening")&&!r.hasClass("card-closing")){var i=r.children(".card-content"),n=r.parents(".page-content"),s=r.parents(".page").eq(0);if(s.length){var o,l,p,c=Object.assign({animate:t},a.params.card,r.dataset());r.attr("data-backdrop-el")&&(p=$(r.attr("data-backdrop-el"))),c.backdrop&&(p=r.parents(".page-content").find(".card-backdrop")),c.hideNavbarOnOpen&&((o=s.children(".navbar")).length||s[0].f7Page&&(o=s[0].f7Page.$navbarEl),o&&o.length&&a.navbar.show(o,c.animate)),c.hideToolbarOnOpen&&((l=s.children(".toolbar")).length||(l=s.parents(".view").children(".toolbar")),l.length||(l=s.parents(".views").children(".toolbar")),l&&l.length&&a.toolbar.show(l,c.animate)),s.removeClass("page-with-card-opened"),a.device.ios&&n.length&&(n.css("height",n[0].offsetHeight+1+"px"),setTimeout(function(){n.css("height","")})),p&&p.length&&p.removeClass("card-backdrop-in").addClass("card-backdrop-out"),r.removeClass("card-opened card-transitioning"),c.animate?r.addClass("card-closing"):r.addClass("card-no-transition"),r.transform(""),r.trigger("card:close"),a.emit("cardClose",r[0]);var d=r.hasClass("card-expandable-animate-width");d&&i.css({width:"",height:""}),i.transform("").scrollTop(0,t?300:0),t?i.transitionEnd(function(){u()}):u(),r[0].detachEventHandlers&&(r[0].detachEventHandlers(),delete r[0].detachEventHandlers)}}function u(){d||i.css({width:"",height:""}),r.removeClass("card-closing card-no-transition"),r.trigger("card:closed"),r.find(".card-expandable-size").remove(),a.emit("cardClosed",r[0],s[0])}},toggle:function(e,t){void 0===e&&(e=".card-expandable");var a=$(e).eq(0);a.length&&(a.hasClass("card-opened")?this.card.close(a,t):this.card.open(a,t))}},Card={name:"card",params:{card:{hideNavbarOnOpen:!0,hideToolbarOnOpen:!0,swipeToClose:!0,closeByBackdropClick:!0,backdrop:!0}},create:function(){Utils.extend(this,{card:{open:CardExpandable.open.bind(this),close:CardExpandable.close.bind(this),toggle:CardExpandable.toggle.bind(this)}})},on:{pageBeforeIn:function(e){if(this.params.card.hideNavbarOnOpen&&e.navbarEl&&e.$el.find(".card-opened.card-expandable").length&&this.navbar.hide(e.navbarEl),this.params.card.hideToolbarOnOpen&&e.$el.find(".card-opened.card-expandable").length){var t=e.$el.children(".toolbar");t.length||(t=e.$el.parents(".view").children(".toolbar")),t.length||(t=e.$el.parents(".views").children(".toolbar")),t&&t.length&&this.toolbar.hide(t)}}},clicks:{".card-close":function(e,t){this.card.close(t.card,t.animate)},".card-open":function(e,t){this.card.open(t.card,t.animate)},".card-expandable":function(e,t,a){e.hasClass("card-opened")||e.hasClass("card-opening")||e.hasClass("card-closing")||$(a.target).closest(".card-prevent-open, .card-close").length||this.card.open(e)},".card-backdrop-in":function(){var e=!1;this.params.card.closeByBackdropClick&&(e=!0);var t=$(".card-opened");t.length&&("true"===t.attr("data-close-by-backdrop-click")?e=!0:"false"===t.attr("data-close-by-backdrop-click")&&(e=!1),e&&this.card.close(t))}}},Chip={name:"chip"},FormData$1={store:function(e,t){var a=e,r=$(e);r.length&&r.is("form")&&r.attr("id")&&(a=r.attr("id")),this.form.data["form-"+a]=t;try{win.localStorage["f7form-"+a]=JSON.stringify(t)}catch(e){throw e}},get:function(e){var t=e,a=$(e);a.length&&a.is("form")&&a.attr("id")&&(t=a.attr("id"));try{if(win.localStorage["f7form-"+t])return JSON.parse(win.localStorage["f7form-"+t])}catch(e){throw e}if(this.form.data["form-"+t])return this.form.data["form-"+t]},remove:function(e){var t=e,a=$(e);a.length&&a.is("form")&&a.attr("id")&&(t=a.attr("id")),this.form.data["form-"+t]&&(this.form.data["form-"+t]="",delete this.form.data["form-"+t]);try{win.localStorage["f7form-"+t]&&(win.localStorage["f7form-"+t]="",win.localStorage.removeItem("f7form-"+t))}catch(e){throw e}}},FormStorage={init:function(e){var t=this,a=$(e),r=a.attr("id");if(r){var i=t.form.getFormData(r);i&&t.form.fillFromData(a,i),a.on("change submit",function(){var e=t.form.convertToData(a);e&&(t.form.storeFormData(r,e),a.trigger("form:storedata",e),t.emit("formStoreData",a[0],e))})}},destroy:function(e){$(e).off("change submit")}};function formToData(e){var t=$(e).eq(0);if(0!==t.length){var a={},r=["submit","image","button","file"],i=[];return t.find("input, select, textarea").each(function(e,n){var s=$(n);if(!s.hasClass("ignore-store-data")&&!s.hasClass("no-store-data")){var o=s.attr("name"),l=s.attr("type"),p=n.nodeName.toLowerCase();if(!(r.indexOf(l)>=0)&&!(i.indexOf(o)>=0)&&o)if("select"===p&&s.prop("multiple"))i.push(o),a[o]=[],t.find('select[name="'+o+'"] option').each(function(e,t){t.selected&&a[o].push(t.value)});else switch(l){case"checkbox":i.push(o),a[o]=[],t.find('input[name="'+o+'"]').each(function(e,t){t.checked&&a[o].push(t.value)});break;case"radio":i.push(o),t.find('input[name="'+o+'"]').each(function(e,t){t.checked&&(a[o]=t.value)});break;default:a[o]=s.val()}}}),t.trigger("form:todata",a),this.emit("formToData",t[0],a),a}}function formFromData(e,t){var a=$(e).eq(0);if(a.length){var r=t,i=a.attr("id");if(!r&&i&&(r=this.form.getFormData(i)),r){var n=["submit","image","button","file"],s=[];a.find("input, select, textarea").each(function(e,t){var i=$(t);if(!i.hasClass("ignore-store-data")&&!i.hasClass("no-store-data")){var o=i.attr("name"),l=i.attr("type"),p=t.nodeName.toLowerCase();if(void 0!==r[o]&&null!==r[o]&&!(n.indexOf(l)>=0)&&!(s.indexOf(o)>=0)&&o){if("select"===p&&i.prop("multiple"))s.push(o),a.find('select[name="'+o+'"] option').each(function(e,t){var a=t;r[o].indexOf(t.value)>=0?a.selected=!0:a.selected=!1});else switch(l){case"checkbox":s.push(o),a.find('input[name="'+o+'"]').each(function(e,t){var a=t;r[o].indexOf(t.value)>=0?a.checked=!0:a.checked=!1});break;case"radio":s.push(o),a.find('input[name="'+o+'"]').each(function(e,t){var a=t;r[o]===t.value?a.checked=!0:a.checked=!1});break;default:i.val(r[o])}"select"!==p&&"input"!==p&&"textarea"!==p||i.trigger("change","fromdata")}}}),a.trigger("form:fromdata",r),this.emit("formFromData",a[0],r)}}}function initAjaxForm(){var e=this;$(doc).on("submit change","form.form-ajax-submit, form.form-ajax-submit-onchange",function(t,a){var r=$(this);if(("change"!==t.type||r.hasClass("form-ajax-submit-onchange"))&&("submit"===t.type&&t.preventDefault(),"change"!==t.type||"fromdata"!==a)){var i,n=(r.attr("method")||"GET").toUpperCase(),s=r.prop("enctype")||r.attr("enctype"),o=r.attr("action");o&&(i="POST"===n?"application/x-www-form-urlencoded"===s?e.form.convertToData(r[0]):new win.FormData(r[0]):Utils.serializeObject(e.form.convertToData(r[0])),e.request({method:n,url:o,contentType:s,data:i,beforeSend:function(t){r.trigger("formajax:beforesend",{data:i,xhr:t}),e.emit("formAjaxBeforeSend",r[0],i,t)},error:function(t){r.trigger("formajax:error",{data:i,xhr:t}),e.emit("formAjaxError",r[0],i,t)},complete:function(t){r.trigger("formajax:complete",{data:i,xhr:t}),e.emit("formAjaxComplete",r[0],i,t)},success:function(t,a,n){r.trigger("formajax:success",{data:i,xhr:n}),e.emit("formAjaxSuccess",r[0],i,n)}}))}})}var Form={name:"form",create:function(){Utils.extend(this,{form:{data:{},storeFormData:FormData$1.store.bind(this),getFormData:FormData$1.get.bind(this),removeFormData:FormData$1.remove.bind(this),convertToData:formToData.bind(this),fillFromData:formFromData.bind(this),storage:{init:FormStorage.init.bind(this),destroy:FormStorage.destroy.bind(this)}}})},on:{init:function(){initAjaxForm.call(this)},tabBeforeRemove:function(e){var t=this;$(e).find(".form-store-data").each(function(e,a){t.form.storage.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".form-store-data").each(function(e,a){t.form.storage.init(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".form-store-data").each(function(e,a){t.form.storage.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".form-store-data").each(function(e,a){t.form.storage.init(a)})}}},Input={ignoreTypes:["checkbox","button","submit","range","radio","image"],createTextareaResizableShadow:function(){var e=$(doc.createElement("textarea"));e.addClass("textarea-resizable-shadow"),e.prop({disabled:!0,readonly:!0}),Input.textareaResizableShadow=e},textareaResizableShadow:void 0,resizeTextarea:function(e){var t=$(e);Input.textareaResizableShadow||Input.createTextareaResizableShadow();var a=Input.textareaResizableShadow;if(t.length&&t.hasClass("resizable")){0===Input.textareaResizableShadow.parents().length&&this.root.append(a);var r=win.getComputedStyle(t[0]);"padding-top padding-bottom padding-left padding-right margin-left margin-right margin-top margin-bottom width font-size font-family font-style font-weight line-height font-variant text-transform letter-spacing border box-sizing display".split(" ").forEach(function(e){var t=r[e];"font-size line-height letter-spacing width".split(" ").indexOf(e)>=0&&(t=t.replace(",",".")),a.css(e,t)});var i=t[0].clientHeight;a.val("");var n=a[0].scrollHeight;a.val(t.val()),a.css("height",0);var s=a[0].scrollHeight;i!==s&&(s>n?(t.css("height",s+"px"),t.trigger("textarea:resize",{initialHeight:n,currentHeight:i,scrollHeight:s})):s<i&&(t.css("height",""),t.trigger("textarea:resize",{initialHeight:n,currentHeight:i,scrollHeight:s})))}},validate:function(e){var t=$(e);if(t.length){var a=t.parents(".item-input"),r=t.parents(".input"),i=t[0].validity,n=t.dataset().errorMessage||t[0].validationMessage||"";if(i)if(i.valid)a.removeClass("item-input-invalid item-input-with-error-message"),r.removeClass("input-invalid input-with-error-message"),t.removeClass("input-invalid");else{var s=t.nextAll(".item-input-error-message, .input-error-message");n&&(0===s.length&&(s=$('<div class="'+(r.length?"input-error-message":"item-input-error-message")+'"></div>')).insertAfter(t),s.text(n)),s.length>0&&(a.addClass("item-input-with-error-message"),r.addClass("input-with-error-message")),a.addClass("item-input-invalid"),r.addClass("input-invalid"),t.addClass("input-invalid")}}},validateInputs:function(e){var t=this;$(e).find("input, textarea, select").each(function(e,a){t.input.validate(a)})},focus:function(e){var t=$(e),a=t.attr("type");Input.ignoreTypes.indexOf(a)>=0||(t.parents(".item-input").addClass("item-input-focused"),t.parents(".input").addClass("input-focused"),t.addClass("input-focused"))},blur:function(e){var t=$(e);t.parents(".item-input").removeClass("item-input-focused"),t.parents(".input").removeClass("input-focused"),t.removeClass("input-focused")},checkEmptyState:function(e){var t=$(e);if(t.is("input, select, textarea")||(t=t.find("input, select, textarea").eq(0)),t.length){var a=t.val(),r=t.parents(".item-input"),i=t.parents(".input");a&&"string"==typeof a&&""!==a.trim()||Array.isArray(a)&&a.length>0?(r.addClass("item-input-with-value"),i.addClass("input-with-value"),t.addClass("input-with-value"),t.trigger("input:notempty")):(r.removeClass("item-input-with-value"),i.removeClass("input-with-value"),t.removeClass("input-with-value"),t.trigger("input:empty"))}},scrollIntoView:function(e,t,a,r){void 0===t&&(t=0);var i=$(e),n=i.parents(".page-content, .panel").eq(0);if(!n.length)return!1;var s=n[0].offsetHeight,o=n[0].scrollTop,l=parseInt(n.css("padding-top"),10),p=parseInt(n.css("padding-bottom"),10),c=n.offset().top-o,d=i.offset().top-c,u=d+o-l,h=d+o-s+p+i[0].offsetHeight,f=u+(h-u)/2;return o>u?(n.scrollTop(a?f:u,t),!0):o<h?(n.scrollTop(a?f:h,t),!0):(r&&n.scrollTop(a?f:h,t),!1)},init:function(){var e=this;Input.createTextareaResizableShadow(),$(doc).on("click",".input-clear-button",function(){var e=$(this).siblings("input, textarea").eq(0),t=e.val();e.val("").trigger("input change").focus().trigger("input:clear",t)}),$(doc).on("change input","input, textarea, select",function(){var t=$(this),a=t.attr("type"),r=t[0].nodeName.toLowerCase();Input.ignoreTypes.indexOf(a)>=0||(e.input.checkEmptyState(t),null!==t.attr("data-validate-on-blur")||!t.dataset().validate&&null===t.attr("validate")||e.input.validate(t),"textarea"===r&&t.hasClass("resizable")&&e.input.resizeTextarea(t))},!0),$(doc).on("focus","input, textarea, select",function(){var t=this;e.params.input.scrollIntoViewOnFocus&&(Device.android?$(win).once("resize",function(){doc&&doc.activeElement===t&&e.input.scrollIntoView(t,e.params.input.scrollIntoViewDuration,e.params.input.scrollIntoViewCentered,e.params.input.scrollIntoViewAlways)}):e.input.scrollIntoView(t,e.params.input.scrollIntoViewDuration,e.params.input.scrollIntoViewCentered,e.params.input.scrollIntoViewAlways)),e.input.focus(t)},!0),$(doc).on("blur","input, textarea, select",function(){var t=$(this),a=t[0].nodeName.toLowerCase();e.input.blur(t),(t.dataset().validate||null!==t.attr("validate")||null!==t.attr("data-validate-on-blur"))&&e.input.validate(t),"textarea"===a&&t.hasClass("resizable")&&Input.textareaResizableShadow&&Input.textareaResizableShadow.remove()},!0),$(doc).on("invalid","input, textarea, select",function(t){var a=$(this);null!==a.attr("data-validate-on-blur")||!a.dataset().validate&&null===a.attr("validate")||(t.preventDefault(),e.input.validate(a))},!0)}},Input$1={name:"input",params:{input:{scrollIntoViewOnFocus:Device.android,scrollIntoViewCentered:!1,scrollIntoViewDuration:0,scrollIntoViewAlways:!1}},create:function(){Utils.extend(this,{input:{scrollIntoView:Input.scrollIntoView.bind(this),focus:Input.focus.bind(this),blur:Input.blur.bind(this),validate:Input.validate.bind(this),validateInputs:Input.validateInputs.bind(this),checkEmptyState:Input.checkEmptyState.bind(this),resizeTextarea:Input.resizeTextarea.bind(this),init:Input.init.bind(this)}})},on:{init:function(){this.input.init()},tabMounted:function(e){var t=this,a=$(e);a.find(".item-input, .input").each(function(e,a){$(a).find("input, select, textarea").each(function(e,a){var r=$(a);Input.ignoreTypes.indexOf(r.attr("type"))>=0||t.input.checkEmptyState(r)})}),a.find("textarea.resizable").each(function(e,a){t.input.resizeTextarea(a)})},pageInit:function(e){var t=this,a=e.$el;a.find(".item-input, .input").each(function(e,a){$(a).find("input, select, textarea").each(function(e,a){var r=$(a);Input.ignoreTypes.indexOf(r.attr("type"))>=0||t.input.checkEmptyState(r)})}),a.find("textarea.resizable").each(function(e,a){t.input.resizeTextarea(a)})}}},Checkbox={name:"checkbox"},Radio={name:"radio"},Toggle=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i={};r.useModulesParams(i),r.params=Utils.extend(i,a);var n=r.params.el;if(!n)return r;var s=$(n);if(0===s.length)return r;if(s[0].f7Toggle)return s[0].f7Toggle;var o,l=s.children('input[type="checkbox"]');Utils.extend(r,{app:t,$el:s,el:s[0],$inputEl:l,inputEl:l[0],disabled:s.hasClass("disabled")||l.hasClass("disabled")||l.attr("disabled")||l[0].disabled}),Object.defineProperty(r,"checked",{enumerable:!0,configurable:!0,set:function(e){r&&void 0!==r.$inputEl&&r.checked!==e&&(l[0].checked=e,r.$inputEl.trigger("change"))},get:function(){return l[0].checked}}),s[0].f7Toggle=r;var p,c,d,u,h,f={};function v(e){o||r.disabled||(f.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,f.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,c=0,o=!0,p=void 0,u=Utils.now(),h=r.checked,d=s[0].offsetWidth,Utils.nextTick(function(){o&&s.addClass("toggle-active-state")}))}function m(e){if(o&&!r.disabled){var a,i="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,n="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,s=t.rtl?-1:1;if(void 0===p&&(p=!!(p||Math.abs(n-f.y)>Math.abs(i-f.x))),p)o=!1;else e.preventDefault(),(c=i-f.x)*s<0&&Math.abs(c)>d/3&&h&&(a=!0),c*s>0&&Math.abs(c)>d/3&&!h&&(a=!0),a&&(f.x=i,r.checked=!h,h=!h)}}function g(){if(!o||r.disabled)return p&&s.removeClass("toggle-active-state"),void(o=!1);var e,a=t.rtl?-1:1;o=!1,s.removeClass("toggle-active-state"),Utils.now()-u<300&&(c*a<0&&h&&(e=!0),c*a>0&&!h&&(e=!0),e&&(r.checked=!h))}function b(){r.$el.trigger("toggle:change",r),r.emit("local::change toggleChange",r)}r.attachEvents=function(){if(Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.on(t.touchEvents.start,v,e),t.on("touchmove",m),t.on("touchend:passive",g)}r.$inputEl.on("change",b)},r.detachEvents=function(){if(Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.off(t.touchEvents.start,v,e),t.off("touchmove",m),t.off("touchend:passive",g)}r.$inputEl.off("change",b)},r.useModules(),r.init()}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.toggle=function(){this.checked=!this.checked},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.$el.trigger("toggle:beforedestroy",e),e.emit("local::beforeDestroy toggleBeforeDestroy",e),delete e.$el[0].f7Toggle,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Toggle$1={name:"toggle",create:function(){this.toggle=ConstructorMethods({defaultSelector:".toggle",constructor:Toggle,app:this,domProp:"f7Toggle"})},static:{Toggle:Toggle},on:{tabMounted:function(e){var t=this;$(e).find(".toggle-init").each(function(e,a){return t.toggle.create({el:a})})},tabBeforeRemove:function(e){$(e).find(".toggle-init").each(function(e,t){t.f7Toggle&&t.f7Toggle.destroy()})},pageInit:function(e){var t=this;e.$el.find(".toggle-init").each(function(e,a){return t.toggle.create({el:a})})},pageBeforeRemove:function(e){e.$el.find(".toggle-init").each(function(e,t){t.f7Toggle&&t.f7Toggle.destroy()})}},vnode:{"toggle-init":{insert:function(e){var t=e.elm;this.toggle.create({el:t})},destroy:function(e){var t=e.elm;t.f7Toggle&&t.f7Toggle.destroy()}}}},Range=function(e){function t(t,a){e.call(this,a,[t]);var r=this,i={el:null,inputEl:null,dual:!1,step:1,label:!1,min:0,max:100,value:0,draggableBar:!0,vertical:!1,verticalReversed:!1,formatLabel:null,scale:!1,scaleSteps:5,scaleSubSteps:0,formatScaleLabel:null,limitKnobPosition:"ios"===t.theme};r.useModulesParams(i),r.params=Utils.extend(i,a);var n=r.params.el;if(!n)return r;var s=$(n);if(0===s.length)return r;if(s[0].f7Range)return s[0].f7Range;var o,l=s.dataset();"step min max value scaleSteps scaleSubSteps".split(" ").forEach(function(e){void 0===a[e]&&void 0!==l[e]&&(r.params[e]=parseFloat(l[e]))}),"dual label vertical verticalReversed scale".split(" ").forEach(function(e){void 0===a[e]&&void 0!==l[e]&&(r.params[e]=l[e])}),r.params.value||(void 0!==l.value&&(r.params.value=l.value),void 0!==l.valueLeft&&void 0!==l.valueRight&&(r.params.value=[parseFloat(l.valueLeft),parseFloat(l.valueRight)])),r.params.dual||(r.params.inputEl?o=$(r.params.inputEl):s.find('input[type="range"]').length&&(o=s.find('input[type="range"]').eq(0)));var p=r.params,c=p.dual,d=p.step,u=p.label,h=p.min,f=p.max,v=p.value,m=p.vertical,g=p.verticalReversed,b=p.scale,y=p.scaleSteps,w=p.scaleSubSteps,C=p.limitKnobPosition;Utils.extend(r,{app:t,$el:s,el:s[0],$inputEl:o,inputEl:o?o[0]:void 0,dual:c,step:d,label:u,min:h,max:f,value:v,previousValue:v,vertical:m,verticalReversed:g,scale:b,scaleSteps:y,scaleSubSteps:w,limitKnobPosition:C}),o&&("step min max".split(" ").forEach(function(e){!a[e]&&o.attr(e)&&(r.params[e]=parseFloat(o.attr(e)),r[e]=parseFloat(o.attr(e)))}),void 0!==o.val()&&(r.params.value=parseFloat(o.val()),r.value=parseFloat(o.val()))),r.dual&&s.addClass("range-slider-dual"),r.label&&s.addClass("range-slider-label"),r.vertical?(s.addClass("range-slider-vertical"),r.verticalReversed&&s.addClass("range-slider-vertical-reversed")):s.addClass("range-slider-horizontal");var x=$('<div class="range-bar"></div>'),k=$('<div class="range-bar-active"></div>');x.append(k);var E='\n      <div class="range-knob-wrap">\n        <div class="range-knob"></div>\n        '+(r.label?'<div class="range-knob-label"></div>':"")+"\n      </div>\n    ",S=[$(E)];r.dual&&S.push($(E)),s.append(x),S.forEach(function(e){s.append(e)});var T,M,P=[];r.label&&(P.push(S[0].find(".range-knob-label")),r.dual&&P.push(S[1].find(".range-knob-label"))),r.scale&&r.scaleSteps>1&&(T=$('\n        <div class="range-scale">\n          '+r.renderScale()+"\n        </div>\n      "),s.append(T)),Utils.extend(r,{knobs:S,labels:P,$barEl:x,$barActiveEl:k,$scaleEl:T}),s[0].f7Range=r;var O,D,I,R,B,L,A,z,H,U,N,V={};function F(){A=!0}function j(e){if(!M&&(r.params.draggableBar||0!==$(e.target).closest(".range-knob").length)){var t;A=!1,V.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,V.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,"touchstart"===e.type&&(z=e.targetTouches[0].identifier),M=!0,O=void 0,D=s.offset(),I=D.left,R=D.top,r.vertical?(t=(V.y-R)/r.rangeHeight,r.verticalReversed||(t=1-t)):t=r.app.rtl?(I+r.rangeWidth-V.x)/r.rangeWidth:(V.x-I)/r.rangeWidth;var a=t*(r.max-r.min)+r.min;r.dual?Math.abs(r.value[0]-a)<Math.abs(r.value[1]-a)?(L=0,B=r.knobs[0],a=[a,r.value[1]]):(L=1,B=r.knobs[1],a=[r.value[0],a]):(B=r.knobs[0],a=t*(r.max-r.min)+r.min),Utils.nextTick(function(){M&&B.addClass("range-knob-active-state")},70),r.on("change",F),r.setValue(a,!0)}}function q(e){if(M){var t,a;if("touchmove"===e.type)for(var i=0;i<e.targetTouches.length;i+=1)e.targetTouches[i].identifier===z&&(t=e.targetTouches[i].pageX,a=e.targetTouches[i].pageY);else t=e.pageX,a=e.pageY;if(void 0!==t||void 0!==a)if(void 0!==O||r.vertical||(O=!!(O||Math.abs(a-V.y)>Math.abs(t-V.x))),O)M=!1;else{var n;e.preventDefault(),r.vertical?(n=(a-R)/r.rangeHeight,r.verticalReversed||(n=1-n)):n=r.app.rtl?(I+r.rangeWidth-t)/r.rangeWidth:(t-I)/r.rangeWidth;var s,o,l=n*(r.max-r.min)+r.min;if(r.dual)0===L?(s=l)>(o=r.value[1])&&(o=s):(o=l)<(s=r.value[0])&&(s=o),l=[s,o];r.setValue(l,!0)}}}function Y(e){if("touchend"===e.type){for(var t,a=0;a<e.changedTouches.length;a+=1)e.changedTouches[a].identifier===z&&(t=!0);if(!t)return}if(!M)return O&&B.removeClass("range-knob-active-state"),void(M=!1);r.off("change",F),M=!1,B.removeClass("range-knob-active-state"),A&&r.$inputEl&&!r.dual&&r.$inputEl.trigger("change"),A=!1,void 0!==r.previousValue&&(r.dual&&(r.previousValue[0]!==r.value[0]||r.previousValue[1]!==r.value[1])||!r.dual&&r.previousValue!==r.value)&&(r.$el.trigger("range:changed",r,r.value),r.emit("local::changed rangeChanged",r,r.value))}function _(){r.calcSize(),r.layout()}return r.attachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};r.$el.on(t.touchEvents.start,j,e),t.on("touchmove",q),t.on("touchend:passive",Y),t.on("tabShow",_),t.on("resize",_),(H=r.$el.parents(".sheet-modal, .actions-modal, .popup, .popover, .login-screen, .dialog, .toast")).on("modal:open",_),(U=r.$el.parents(".panel")).on("panel:open",_),(N=r.$el.parents(".page").eq(0)).on("page:reinit",_)},r.detachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};r.$el.off(t.touchEvents.start,j,e),t.off("touchmove",q),t.off("touchend:passive",Y),t.off("tabShow",_),t.off("resize",_),H&&H.off("modal:open",_),U&&U.off("panel:open",_),N&&N.off("page:reinit",_),H=null,U=null,N=null},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.calcSize=function(){if(this.vertical){var e=this.$el.outerHeight();if(0===e)return;this.rangeHeight=e,this.knobHeight=this.knobs[0].outerHeight()}else{var t=this.$el.outerWidth();if(0===t)return;this.rangeWidth=t,this.knobWidth=this.knobs[0].outerWidth()}},t.prototype.layout=function(){var e,t=this,a=t.app,r=t.knobWidth,i=t.knobHeight,n=t.rangeWidth,s=t.rangeHeight,o=t.min,l=t.max,p=t.knobs,c=t.$barActiveEl,d=t.value,u=t.label,h=t.labels,f=t.vertical,v=t.verticalReversed,m=t.limitKnobPosition,g=f?i:r,b=f?s:n,y=f?v?"top":"bottom":a.rtl?"right":"left";if(t.dual){var w=[(d[0]-o)/(l-o),(d[1]-o)/(l-o)];c.css(((e={})[y]=100*w[0]+"%",e[f?"height":"width"]=100*(w[1]-w[0])+"%",e)),p.forEach(function(e,a){var r=b*w[a];if(m){var i=b*w[a]-g/2;i<0&&(r=g/2),i+g>b&&(r=b-g/2)}e.css(y,r+"px"),u&&h[a].text(t.formatLabel(d[a],h[a][0]))})}else{var C=(d-o)/(l-o);c.css(f?"height":"width",100*C+"%");var x=b*C;if(m){var $=b*C-g/2;$<0&&(x=g/2),$+g>b&&(x=b-g/2)}p[0].css(y,x+"px"),u&&h[0].text(t.formatLabel(d,h[0][0]))}t.dual&&d.indexOf(o)>=0||!t.dual&&d===o?t.$el.addClass("range-slider-min"):t.$el.removeClass("range-slider-min"),t.dual&&d.indexOf(l)>=0||!t.dual&&d===l?t.$el.addClass("range-slider-max"):t.$el.removeClass("range-slider-max")},t.prototype.setValue=function(e,t){var a,r,i=this,n=i.step,s=i.min,o=i.max;if(i.dual){r=[i.value[0],i.value[1]];var l=e;if(Array.isArray(l)||(l=[e,e]),e[0]>e[1]&&(l=[l[0],l[0]]),(l=l.map(function(e){return Math.max(Math.min(Math.round(e/n)*n,o),s)}))[0]===i.value[0]&&l[1]===i.value[1])return i;l.forEach(function(e,t){i.value[t]=e}),a=r[0]!==l[0]||r[1]!==l[1],i.layout()}else{r=i.value;var p=Math.max(Math.min(Math.round(e/n)*n,o),s);i.value=p,i.layout(),a=r!==p}return a&&(i.previousValue=r),a?(i.$el.trigger("range:change",i,i.value),i.$inputEl&&!i.dual&&(i.$inputEl.val(i.value),t?i.$inputEl.trigger("input"):i.$inputEl.trigger("input change")),t||(i.$el.trigger("range:changed",i,i.value),i.emit("local::changed rangeChanged",i,i.value)),i.emit("local::change rangeChange",i,i.value),i):i},t.prototype.getValue=function(){return this.value},t.prototype.formatLabel=function(e,t){return this.params.formatLabel?this.params.formatLabel.call(this,e,t):e},t.prototype.formatScaleLabel=function(e){return this.params.formatScaleLabel?this.params.formatScaleLabel.call(this,e):e},t.prototype.renderScale=function(){var e=this,t=e.app,a=e.verticalReversed,r=e.vertical?a?"top":"bottom":t.rtl?"right":"left",i="";return Array.from({length:e.scaleSteps+1}).forEach(function(t,a){var n=(e.max-e.min)/e.scaleSteps,s=e.min+n*a,o=(s-e.min)/(e.max-e.min);i+='<div class="range-scale-step" style="'+r+": "+100*o+'%">'+e.formatScaleLabel(s)+"</div>",e.scaleSubSteps&&e.scaleSubSteps>1&&a<e.scaleSteps&&Array.from({length:e.scaleSubSteps-1}).forEach(function(t,a){var o=n/e.scaleSubSteps,l=(s+o*(a+1)-e.min)/(e.max-e.min);i+='<div class="range-scale-step range-scale-substep" style="'+r+": "+100*l+'%"></div>'})}),i},t.prototype.updateScale=function(){if(!this.scale||this.scaleSteps<2)return this.$scaleEl&&this.$scaleEl.remove(),void delete this.$scaleEl;this.$scaleEl||(this.$scaleEl=$('<div class="range-scale"></div>'),this.$el.append(this.$scaleEl)),this.$scaleEl.html(this.renderScale())},t.prototype.init=function(){return this.calcSize(),this.layout(),this.attachEvents(),this},t.prototype.destroy=function(){var e=this;e.$el.trigger("range:beforedestroy",e),e.emit("local::beforeDestroy rangeBeforeDestroy",e),delete e.$el[0].f7Range,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Range$1={name:"range",create:function(){var e=this;e.range=Utils.extend(ConstructorMethods({defaultSelector:".range-slider",constructor:Range,app:e,domProp:"f7Range"}),{getValue:function(t){void 0===t&&(t=".range-slider");var a=e.range.get(t);if(a)return a.getValue()},setValue:function(t,a){void 0===t&&(t=".range-slider");var r=e.range.get(t);if(r)return r.setValue(a)}})},static:{Range:Range},on:{tabMounted:function(e){var t=this;$(e).find(".range-slider-init").each(function(e,a){return new Range(t,{el:a})})},tabBeforeRemove:function(e){$(e).find(".range-slider-init").each(function(e,t){t.f7Range&&t.f7Range.destroy()})},pageInit:function(e){var t=this;e.$el.find(".range-slider-init").each(function(e,a){return new Range(t,{el:a})})},pageBeforeRemove:function(e){e.$el.find(".range-slider-init").each(function(e,t){t.f7Range&&t.f7Range.destroy()})}},vnode:{"range-slider-init":{insert:function(e){var t=e.elm;this.range.create({el:t})},destroy:function(e){var t=e.elm;t.f7Range&&t.f7Range.destroy()}}}},Stepper=function(e){function t(t,a){e.call(this,a,[t]);var r=this,i={el:null,inputEl:null,valueEl:null,value:0,formatValue:null,step:1,min:0,max:100,watchInput:!0,autorepeat:!1,autorepeatDynamic:!1,wraps:!1,manualInputMode:!1,decimalPoint:4,buttonsEndInputMode:!0};r.useModulesParams(i),r.params=Utils.extend(i,a),r.params.value<r.params.min&&(r.params.value=r.params.min),r.params.value>r.params.max&&(r.params.value=r.params.max);var n=r.params.el;if(!n)return r;var s,o,l=$(n);if(0===l.length)return r;if(l[0].f7Stepper)return l[0].f7Stepper;if(r.params.inputEl?s=$(r.params.inputEl):l.find(".stepper-input-wrap").find("input, textarea").length&&(s=l.find(".stepper-input-wrap").find("input, textarea").eq(0)),s&&s.length){"step min max".split(" ").forEach(function(e){!a[e]&&s.attr(e)&&(r.params[e]=parseFloat(s.attr(e)))});var p=parseInt(r.params.decimalPoint,10);Number.isNaN(p)?r.params.decimalPoint=0:r.params.decimalPoint=p;var c=parseFloat(s.val());void 0!==a.value||Number.isNaN(c)||!c&&0!==c||(r.params.value=c)}r.params.valueEl?o=$(r.params.valueEl):l.find(".stepper-value").length&&(o=l.find(".stepper-value").eq(0));var d=l.find(".stepper-button-plus"),u=l.find(".stepper-button-minus"),h=r.params,f=h.step,v=h.min,m=h.max,g=h.value,b=h.decimalPoint;Utils.extend(r,{app:t,$el:l,el:l[0],$buttonPlusEl:d,buttonPlusEl:d[0],$buttonMinusEl:u,buttonMinusEl:u[0],$inputEl:s,inputEl:s?s[0]:void 0,$valueEl:o,valueEl:o?o[0]:void 0,step:f,min:v,max:m,value:g,decimalPoint:b,typeModeChanged:!1}),l[0].f7Stepper=r;var y,w,C,x,k,E={},S=null,T=!1,M=!1;function P(e){y||(M||($(e.target).closest(d).length?S="increment":$(e.target).closest(u).length&&(S="decrement"),S&&(E.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,E.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,y=!0,w=void 0,function e(t,a,r,i,n,s){clearTimeout(k),k=setTimeout(function(){1===t&&(C=!0,T=!0),clearInterval(x),s(),x=setInterval(function(){s()},n),t<a&&e(t+1,a,r,i,n/2,s)},1===t?r:i)}(1,r.params.autorepeatDynamic?4:1,500,1e3,300,function(){r[S]()}))))}function O(e){if(y&&!M){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;void 0!==w||T||(w=!!(w||Math.abs(a-E.y)>Math.abs(t-E.x)));var r=Math.pow(Math.pow(t-E.x,2)+Math.pow(a-E.y,2),.5);(w||r>20)&&(y=!1,clearTimeout(k),clearInterval(x))}}function D(){clearTimeout(k),clearInterval(x),S=null,T=!1,y=!1}function I(){M?r.params.buttonsEndInputMode&&(M=!1,r.endTypeMode(!0)):C?C=!1:r.decrement(!0)}function R(){M?r.params.buttonsEndInputMode&&(M=!1,r.endTypeMode(!0)):C?C=!1:r.increment(!0)}function B(e){!e.target.readOnly&&r.params.manualInputMode&&(M=!0,"number"==typeof e.target.selectionStart&&(e.target.selectionStart=e.target.value.length,e.target.selectionEnd=e.target.value.length))}function L(e){13!==e.keyCode&&13!==e.which||(e.preventDefault(),M=!1,r.endTypeMode())}function A(){M=!1,r.endTypeMode(!0)}function z(e){M?r.typeValue(e.target.value):e.detail&&e.detail.sentByF7Stepper||r.setValue(e.target.value,!0)}return r.attachEvents=function(){u.on("click",I),d.on("click",R),r.params.watchInput&&s&&s.length&&(s.on("input",z),s.on("click",B),s.on("blur",A),s.on("keyup",L)),r.params.autorepeat&&(t.on("touchstart:passive",P),t.on("touchmove:active",O),t.on("touchend:passive",D))},r.detachEvents=function(){u.off("click",I),d.off("click",R),r.params.watchInput&&s&&s.length&&(s.off("input",z),s.off("click",B),s.off("blur",A),s.off("keyup",L))},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.minus=function(){return this.decrement()},t.prototype.plus=function(){return this.increment()},t.prototype.decrement=function(){return this.setValue(this.value-this.step,!1,!0)},t.prototype.increment=function(){return this.setValue(this.value+this.step,!1,!0)},t.prototype.setValue=function(e,t,a){var r=this.step,i=this.min,n=this.max,s=this.value,o=Math.round(e/r)*r;if(this.params.wraps&&a?(o>n&&(o=i),o<i&&(o=n)):o=Math.max(Math.min(o,n),i),Number.isNaN(o)&&(o=s),this.value=o,!(s!==o)&&!t)return this;this.$el.trigger("stepper:change",this,this.value);var l=this.formatValue(this.value);return this.$inputEl&&this.$inputEl.length&&(this.$inputEl.val(l),this.$inputEl.trigger("input change",{sentByF7Stepper:!0})),this.$valueEl&&this.$valueEl.length&&this.$valueEl.html(l),this.emit("local::change stepperChange",this,this.value),this},t.prototype.endTypeMode=function(e){var t=this.min,a=this.max,r=parseFloat(this.value);if(Number.isNaN(r)&&(r=0),r=Math.max(Math.min(r,a),t),this.value=r,!this.typeModeChanged)return this.$inputEl&&this.$inputEl.length&&!e&&this.$inputEl.blur(),this;this.typeModeChanged=!1,this.$el.trigger("stepper:change",this,this.value);var i=this.formatValue(this.value);return this.$inputEl&&this.$inputEl.length&&(this.$inputEl.val(i),this.$inputEl.trigger("input change",{sentByF7Stepper:!0}),e||this.$inputEl.blur()),this.$valueEl&&this.$valueEl.length&&this.$valueEl.html(i),this.emit("local::change stepperChange",this,this.value),this},t.prototype.typeValue=function(e){this.typeModeChanged=!0;var t=String(e);if(t.lastIndexOf(".")+1!==t.length&&t.lastIndexOf(",")+1!==t.length){var a=parseFloat(t.replace(",","."));if(0===a)return this.value=t.replace(",","."),this.$inputEl.val(this.value),this;if(Number.isNaN(a))return this.value=0,this.$inputEl.val(this.value),this;var r=Math.pow(10,this.params.decimalPoint);return a=Math.round(a*r).toFixed(this.params.decimalPoint+1)/r,this.value=parseFloat(String(a).replace(",",".")),this.$inputEl.val(this.value),this}return t.lastIndexOf(".")!==t.indexOf(".")||t.lastIndexOf(",")!==t.indexOf(",")?(t=t.slice(0,-1),this.value=t,this.$inputEl.val(this.value),this):(this.value=t,this.$inputEl.val(t),this)},t.prototype.getValue=function(){return this.value},t.prototype.formatValue=function(e){return this.params.formatValue?this.params.formatValue.call(this,e):e},t.prototype.init=function(){if(this.attachEvents(),this.$valueEl&&this.$valueEl.length){var e=this.formatValue(this.value);this.$valueEl.html(e)}return this},t.prototype.destroy=function(){var e=this;e.$el.trigger("stepper:beforedestroy",e),e.emit("local::beforeDestroy stepperBeforeDestroy",e),delete e.$el[0].f7Stepper,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),Stepper$1={name:"stepper",create:function(){var e=this;e.stepper=Utils.extend(ConstructorMethods({defaultSelector:".stepper",constructor:Stepper,app:e,domProp:"f7Stepper"}),{getValue:function(t){void 0===t&&(t=".stepper");var a=e.stepper.get(t);if(a)return a.getValue()},setValue:function(t,a){void 0===t&&(t=".stepper");var r=e.stepper.get(t);if(r)return r.setValue(a)}})},static:{Stepper:Stepper},on:{tabMounted:function(e){var t=this;$(e).find(".stepper-init").each(function(e,a){var r=$(a).dataset();t.stepper.create(Utils.extend({el:a},r||{}))})},tabBeforeRemove:function(e){$(e).find(".stepper-init").each(function(e,t){t.f7Stepper&&t.f7Stepper.destroy()})},pageInit:function(e){var t=this;e.$el.find(".stepper-init").each(function(e,a){var r=$(a).dataset();t.stepper.create(Utils.extend({el:a},r||{}))})},pageBeforeRemove:function(e){e.$el.find(".stepper-init").each(function(e,t){t.f7Stepper&&t.f7Stepper.destroy()})}},vnode:{"stepper-init":{insert:function(e){var t=e.elm,a=$(t).dataset();this.stepper.create(Utils.extend({el:t},a||{}))},destroy:function(e){var t=e.elm;t.f7Stepper&&t.f7Stepper.destroy()}}}},SmartSelect=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i=Utils.extend({on:{}},t.params.smartSelect);void 0===i.searchbarDisableButton&&(i.searchbarDisableButton="aurora"!==t.theme),r.useModulesParams(i),r.params=Utils.extend({},i,a),r.app=t;var n=$(r.params.el).eq(0);if(0===n.length)return r;if(n[0].f7SmartSelect)return n[0].f7SmartSelect;var s,o=n.find("select").eq(0);if(0===o.length)return r;r.params.setValueText&&(0===(s=$(r.params.valueEl)).length&&(s=n.find(".item-after")),0===s.length&&(s=$('<div class="item-after"></div>')).insertAfter(n.find(".item-title")));var l=a.url;l||(n.attr("href")&&"#"!==n.attr("href")?l=n.attr("href"):o.attr("name")&&(l=o.attr("name").toLowerCase()+"-select/")),l||(l=r.params.url);var p=o[0].multiple,c=p?"checkbox":"radio",d=Utils.id();function u(){r.open()}function h(){var e=r.$selectEl.val();r.$el.trigger("smartselect:change",r,e),r.emit("local::change smartSelectChange",r,e),r.setValueText()}function f(){var e,t,a,i=this.value,n=[];if("checkbox"===this.type){for(var s=0;s<r.selectEl.options.length;s+=1)(e=r.selectEl.options[s]).value===i&&(e.selected=this.checked),e.selected&&(t=(a=e.dataset?e.dataset.displayAs:$(e).data("display-value-as"))&&void 0!==a?a:e.textContent,n.push(t.trim()));r.maxLength&&r.checkMaxLength()}else n=[t=(a=(e=r.$selectEl.find('option[value="'+i+'"]')[0]).dataset?e.dataset.displayAs:$(e).data("display-as"))&&void 0!==a?a:e.textContent],r.selectEl.value=i;r.$selectEl.trigger("change"),r.params.setValueText&&r.$valueEl.text(r.formatValueText(n)),r.params.closeOnSelect&&"radio"===r.inputType&&r.close()}return Utils.extend(r,{$el:n,el:n[0],$selectEl:o,selectEl:o[0],$valueEl:s,valueEl:s&&s[0],url:l,multiple:p,inputType:c,id:d,view:void 0,inputName:c+"-"+d,selectName:o.attr("name"),maxLength:o.attr("maxlength")||a.maxLength}),n[0].f7SmartSelect=r,r.attachEvents=function(){n.on("click",u),n.on("change","select",h)},r.detachEvents=function(){n.off("click",u),n.off("change","select",h)},r.attachInputsEvents=function(){r.$containerEl.on("change",'input[type="checkbox"], input[type="radio"]',f)},r.detachInputsEvents=function(){r.$containerEl.off("change",'input[type="checkbox"], input[type="radio"]',f)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setValue=function(e){var t,a,r,i=this,n=e,s=[];if(i.multiple){Array.isArray(n)||(n=[n]);for(var o=0;o<i.selectEl.options.length;o+=1)t=i.selectEl.options[o],n.indexOf(t.value)>=0?t.selected=!0:t.selected=!1,t.selected&&(r=(a=t.dataset?t.dataset.displayAs:$(t).data("display-value-as"))&&void 0!==a?a:t.textContent,s.push(r.trim()))}else(t=i.$selectEl.find('option[value="'+n+'"]')[0])&&(s=[r=(a=t.dataset?t.dataset.displayAs:$(t).data("display-as"))&&void 0!==a?a:t.textContent]),i.selectEl.value=n;return i.params.setValueText&&i.$valueEl.text(i.formatValueText(s)),i},t.prototype.getValue=function(){return this.$selectEl.val()},t.prototype.getView=function(){var e=this,t=e.view||e.params.view;if(t||(t=e.$el.parents(".view").length&&e.$el.parents(".view")[0].f7View),!t)throw Error("Smart Select requires initialized View");return e.view=t,t},t.prototype.checkMaxLength=function(){var e=this.$containerEl;this.selectEl.selectedOptions.length>=this.maxLength?e.find('input[type="checkbox"]').each(function(e,t){t.checked?$(t).parents("li").removeClass("disabled"):$(t).parents("li").addClass("disabled")}):e.find(".disabled").removeClass("disabled")},t.prototype.formatValueText=function(e){return this.params.formatValueText?this.params.formatValueText.call(this,e,this):e.join(", ")},t.prototype.setValueText=function(e){var t=[];void 0!==e?t=Array.isArray(e)?e:[e]:this.$selectEl.find("option").each(function(e,a){var r=$(a);if(a.selected){var i=a.dataset?a.dataset.displayAs:r.data("display-value-as");i&&void 0!==i?t.push(i):t.push(a.textContent.trim())}}),this.params.setValueText&&this.$valueEl.text(this.formatValueText(t))},t.prototype.getItemsData=function(){var e,t=this,a=[];return t.$selectEl.find("option").each(function(r,i){var n=$(i),s=n.dataset(),o=s.optionImage||t.params.optionImage,l=s.optionIcon||t.params.optionIcon,p=o||l,c=s.optionColor,d=s.optionClass||"";n[0].disabled&&(d+=" disabled");var u=n.parent("optgroup")[0],h=u&&u.label,f=!1;u&&u!==e&&(f=!0,e=u,a.push({groupLabel:h,isLabel:f})),a.push({value:n[0].value,text:n[0].textContent.trim(),selected:n[0].selected,groupEl:u,groupLabel:h,image:o,icon:l,color:c,className:d,disabled:n[0].disabled,id:t.id,hasMedia:p,checkbox:"checkbox"===t.inputType,radio:"radio"===t.inputType,inputName:t.inputName,inputType:t.inputType})}),t.items=a,a},t.prototype.renderSearchbar=function(){var e=this;return e.params.renderSearchbar?e.params.renderSearchbar.call(e):'\n      <form class="searchbar">\n        <div class="searchbar-inner">\n          <div class="searchbar-input-wrap">\n            <input type="search" placeholder="'+e.params.searchbarPlaceholder+'"/>\n            <i class="searchbar-icon"></i>\n            <span class="input-clear-button"></span>\n          </div>\n          '+(e.params.searchbarDisableButton?'\n          <span class="searchbar-disable-button">'+e.params.searchbarDisableText+"</span>\n          ":"")+"\n        </div>\n      </form>\n    "},t.prototype.renderItem=function(e,t){return this.params.renderItem?this.params.renderItem.call(this,e,t):e.isLabel?'<li class="item-divider">'+e.groupLabel+"</li>":'\n        <li class="'+(e.className||"")+'">\n          <label class="item-'+e.inputType+' item-content">\n            <input type="'+e.inputType+'" name="'+e.inputName+'" value="'+e.value+'" '+(e.selected?"checked":"")+'/>\n            <i class="icon icon-'+e.inputType+'"></i>\n            '+(e.hasMedia?'\n              <div class="item-media">\n                '+(e.icon?'<i class="icon '+e.icon+'"></i>':"")+"\n                "+(e.image?'<img src="'+e.image+'">':"")+"\n              </div>\n            ":"")+'\n            <div class="item-inner">\n              <div class="item-title'+(e.color?" color-"+e.color:"")+'">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      "},t.prototype.renderItems=function(){var e=this;return e.params.renderItems?e.params.renderItems.call(e,e.items):"\n      "+e.items.map(function(t,a){return""+e.renderItem(t,a)}).join("")+"\n    "},t.prototype.renderPage=function(){var e=this;if(e.params.renderPage)return e.params.renderPage.call(e,e.items);var t=e.params.pageTitle;if(void 0===t){var a=e.$el.find(".item-title");t=a.length?a.text().trim():""}return'\n      <div class="page smart-select-page '+e.params.cssClass+'" data-name="smart-select-page" data-select-name="'+e.selectName+'">\n        <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n          <div class="navbar-inner sliding '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n            <div class="left">\n              <a class="link back">\n                <i class="icon icon-back"></i>\n                <span class="if-not-md">'+e.params.pageBackLinkText+"</span>\n              </a>\n            </div>\n            "+(t?'<div class="title">'+t+"</div>":"")+"\n            "+(e.params.searchbar?'<div class="subnavbar">'+e.renderSearchbar()+"</div>":"")+"\n          </div>\n        </div>\n        "+(e.params.searchbar?'<div class="searchbar-backdrop"></div>':"")+'\n        <div class="page-content">\n          <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n            <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderPopup=function(){var e=this;if(e.params.renderPopup)return e.params.renderPopup.call(e,e.items);var t=e.params.pageTitle;if(void 0===t){var a=e.$el.find(".item-title");t=a.length?a.text().trim():""}return'\n      <div class="popup smart-select-popup '+(e.params.cssClass||"")+" "+(e.params.popupTabletFullscreen?"popup-tablet-fullscreen":"")+'" data-select-name="'+e.selectName+'">\n        <div class="view">\n          <div class="page smart-select-page '+(e.params.searchbar?"page-with-subnavbar":"")+'" data-name="smart-select-page">\n            <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n              <div class="navbar-inner sliding">\n                '+(t?'<div class="title">'+t+"</div>":"")+'\n                <div class="right">\n                  <a class="link popup-close" data-popup=".smart-select-popup[data-select-name=\''+e.selectName+"']\">"+e.params.popupCloseLinkText+"</span></a>\n                </div>\n                "+(e.params.searchbar?'<div class="subnavbar">'+e.renderSearchbar()+"</div>":"")+"\n              </div>\n            </div>\n            "+(e.params.searchbar?'<div class="searchbar-backdrop"></div>':"")+'\n            <div class="page-content">\n              <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n                <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderSheet=function(){var e=this;return e.params.renderSheet?e.params.renderSheet.call(e,e.items):'\n      <div class="sheet-modal smart-select-sheet '+e.params.cssClass+'" data-select-name="'+e.selectName+'">\n        <div class="toolbar toolbar-top '+(e.params.toolbarColorTheme?"color-"+e.params.toolbarColorTheme:"")+'">\n          <div class="toolbar-inner">\n            <div class="left"></div>\n            <div class="right">\n              <a class="link sheet-close">'+e.params.sheetCloseLinkText+'</a>\n            </div>\n          </div>\n        </div>\n        <div class="sheet-modal-inner">\n          <div class="page-content">\n            <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n              <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n            </div>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.renderPopover=function(){var e=this;return e.params.renderPopover?e.params.renderPopover.call(e,e.items):'\n      <div class="popover smart-select-popover '+e.params.cssClass+'" data-select-name="'+e.selectName+'">\n        <div class="popover-inner">\n          <div class="list smart-select-list-'+e.id+" "+(e.params.virtualList?" virtual-list":"")+" "+(e.params.formColorTheme?"color-"+e.params.formColorTheme:"")+'">\n            <ul>'+(!e.params.virtualList&&e.renderItems(e.items))+"</ul>\n          </div>\n        </div>\n      </div>\n    "},t.prototype.scrollToSelectedItem=function(){var e=this,t=e.params,a=e.$containerEl;if(!e.opened)return e;if(t.virtualList){var r;e.vl.items.forEach(function(e,t){void 0===r&&e.selected&&(r=t)}),void 0!==r&&e.vl.scrollToItem(r)}else{var i=a.find("input:checked").parents("li"),n=a.find(".page-content");n.scrollTop(i.offset().top-n.offset().top-parseInt(n.css("padding-top"),10))}return e},t.prototype.onOpen=function(e,t){var a=this,r=a.app,i=$(t);if(a.$containerEl=i,a.openedIn=e,a.opened=!0,a.params.virtualList&&(a.vl=r.virtualList.create({el:i.find(".virtual-list"),items:a.items,renderItem:a.renderItem.bind(a),height:a.params.virtualListHeight,searchByItem:function(e,t){return!!(t.text&&t.text.toLowerCase().indexOf(e.trim().toLowerCase())>=0)}})),a.params.scrollToSelectedItem&&a.scrollToSelectedItem(),a.params.searchbar){var n=i.find(".searchbar");if("page"===e&&"ios"===r.theme&&(n=$(r.navbar.getElByPage(i)).find(".searchbar")),a.params.appendSearchbarNotFound&&("page"===e||"popup"===e)){var s=null;(s="string"==typeof a.params.appendSearchbarNotFound?$('<div class="block searchbar-not-found">'+a.params.appendSearchbarNotFound+"</div>"):"boolean"==typeof a.params.appendSearchbarNotFound?$('<div class="block searchbar-not-found">Nothing found</div>'):a.params.appendSearchbarNotFound)&&i.find(".page-content").append(s[0])}var o=Utils.extend({el:n,backdropEl:i.find(".searchbar-backdrop"),searchContainer:".smart-select-list-"+a.id,searchIn:".item-title"},"object"==typeof a.params.searchbar?a.params.searchbar:{});a.searchbar=r.searchbar.create(o)}a.maxLength&&a.checkMaxLength(),a.params.closeOnSelect&&a.$containerEl.find('input[type="radio"][name="'+a.inputName+'"]:checked').parents("label").once("click",function(){a.close()}),a.attachInputsEvents(),a.$el.trigger("smartselect:open",a),a.emit("local::open smartSelectOpen",a)},t.prototype.onOpened=function(){this.$el.trigger("smartselect:opened",this),this.emit("local::opened smartSelectOpened",this)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.vl&&e.vl.destroy&&(e.vl.destroy(),e.vl=null,delete e.vl),e.searchbar&&e.searchbar.destroy&&(e.searchbar.destroy(),e.searchbar=null,delete e.searchbar),e.detachInputsEvents(),e.$el.trigger("smartselect:close",e),e.emit("local::close smartSelectClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$containerEl=null,delete e.$containerEl,e.$el.trigger("smartselect:closed",e),e.emit("local::closed smartSelectClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;e.getItemsData();var t=e.renderPage(e.items);return e.getView().router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}}}}),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderPopup(e.items),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open();return e},t.prototype.openSheet=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderSheet(e.items),backdrop:!1,scrollToEl:e.$el,closeByOutsideClick:!0,on:{sheetOpen:function(t){e.onOpen("sheet",t.el)},sheetOpened:function(t){e.onOpened("sheet",t.el)},sheetClose:function(t){e.onClose("sheet",t.el)},sheetClosed:function(t){e.onClosed("sheet",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,sheet:t}}):e.modal=e.app.sheet.create(t).open();return e},t.prototype.openPopover=function(){var e=this;if(e.opened)return e;e.getItemsData();var t={content:e.renderPopover(e.items),targetEl:e.$el,on:{popoverOpen:function(t){e.onOpen("popover",t.el)},popoverOpened:function(t){e.onOpened("popover",t.el)},popoverClose:function(t){e.onClose("popover",t.el)},popoverClosed:function(t){e.onClosed("popover",t.el)}}};e.params.routableModals?e.getView().router.navigate({url:e.url,route:{path:e.url,popover:t}}):e.modal=e.app.popover.create(t).open();return e},t.prototype.open=function(e){var t=this;if(t.opened)return t;var a=!1;function r(){a=!0}return t.$el&&t.$el.trigger("smartselect:beforeopen",{prevent:r}),t.emit("local::beforeOpen smartSelectBeforeOpen",t,r),a?t:(t["open"+(e||t.params.openIn).split("").map(function(e,t){return 0===t?e.toUpperCase():e}).join("")](),t)},t.prototype.close=function(){var e=this;if(!e.opened)return e;e.params.routableModals||"page"===e.openedIn?e.getView().router.back():(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.destroyed||(e.modal.destroy(),delete e.modal)})}),e.modal.close());return e},t.prototype.init=function(){this.attachEvents(),this.setValueText()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy smartSelectBeforeDestroy",e),e.$el.trigger("smartselect:beforedestroy",e),e.detachEvents(),delete e.$el[0].f7SmartSelect,Utils.deleteProps(e),e.destroyed=!0},t}(Framework7Class),SmartSelect$1={name:"smartSelect",params:{smartSelect:{el:void 0,valueEl:void 0,setValueText:!0,formatValueText:null,openIn:"page",pageTitle:void 0,pageBackLinkText:"Back",popupCloseLinkText:"Close",popupTabletFullscreen:!1,sheetCloseLinkText:"Done",searchbar:!1,searchbarPlaceholder:"Search",searchbarDisableText:"Cancel",searchbarDisableButton:void 0,closeOnSelect:!1,virtualList:!1,virtualListHeight:void 0,scrollToSelectedItem:!1,formColorTheme:void 0,navbarColorTheme:void 0,routableModals:!0,url:"select/",cssClass:"",renderPage:void 0,renderPopup:void 0,renderSheet:void 0,renderPopover:void 0,renderItems:void 0,renderItem:void 0,renderSearchbar:void 0}},static:{SmartSelect:SmartSelect},create:function(){var e=this;e.smartSelect=Utils.extend(ConstructorMethods({defaultSelector:".smart-select",constructor:SmartSelect,app:e,domProp:"f7SmartSelect"}),{open:function(t){var a=e.smartSelect.get(t);if(a&&a.open)return a.open()},close:function(t){var a=e.smartSelect.get(t);if(a&&a.close)return a.close()}})},on:{tabMounted:function(e){var t=this;$(e).find(".smart-select-init").each(function(e,a){t.smartSelect.create(Utils.extend({el:a},$(a).dataset()))})},tabBeforeRemove:function(e){$(e).find(".smart-select-init").each(function(e,t){t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()})},pageInit:function(e){var t=this;e.$el.find(".smart-select-init").each(function(e,a){t.smartSelect.create(Utils.extend({el:a},$(a).dataset()))})},pageBeforeRemove:function(e){e.$el.find(".smart-select-init").each(function(e,t){t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()})}},clicks:{".smart-select":function(e,t){e[0].f7SmartSelect||this.smartSelect.create(Utils.extend({el:e},t)).open()}},vnode:{"smart-select-init":{insert:function(e){var t=e.elm;this.smartSelect.create(Utils.extend({el:t},$(t).dataset()))},destroy:function(e){var t=e.elm;t.f7SmartSelect&&t.f7SmartSelect.destroy&&t.f7SmartSelect.destroy()}}}},Grid={name:"grid"};function toJalaali(e,t,a){return"[object Date]"===Object.prototype.toString.call(e)&&(a=e.getDate(),t=e.getMonth()+1,e=e.getFullYear()),d2j(g2d(e,t,a))}function toGregorian(e,t,a){return d2g(j2d(e,t,a))}function isLeapJalaaliYear(e){return 0===jalCal(e).leap}function monthLength(e,t){return t<=6?31:t<=11?30:isLeapJalaaliYear(e)?30:29}function jalCal(e){var t,a,r,i,n,s,o=[-61,9,38,199,426,686,756,818,1111,1181,1210,1635,2060,2097,2192,2262,2324,2394,2456,3178],l=o.length,p=e+621,c=-14,d=o[0];if(e<d||e>=o[l-1])throw new Error("Invalid Jalaali year "+e);for(s=1;s<l&&(a=(t=o[s])-d,!(e<t));s+=1)c=c+8*div(a,33)+div(mod(a,33),4),d=t;return c=c+8*div(n=e-d,33)+div(mod(n,33)+3,4),4===mod(a,33)&&a-n==4&&(c+=1),i=20+c-(div(p,4)-div(3*(div(p,100)+1),4)-150),a-n<6&&(n=n-a+33*div(a+4,33)),-1===(r=mod(mod(n+1,33)-1,4))&&(r=4),{leap:r,gy:p,march:i}}function j2d(e,t,a){var r=jalCal(e);return g2d(r.gy,3,r.march)+31*(t-1)-div(t,7)*(t-7)+a-1}function d2j(e){var t,a=d2g(e).gy,r=a-621,i=jalCal(r);if((t=e-g2d(a,3,i.march))>=0){if(t<=185)return{jy:r,jm:1+div(t,31),jd:mod(t,31)+1};t-=186}else r-=1,t+=179,1===i.leap&&(t+=1);return{jy:r,jm:7+div(t,30),jd:mod(t,30)+1}}function g2d(e,t,a){var r=div(1461*(e+div(t-8,6)+100100),4)+div(153*mod(t+9,12)+2,5)+a-34840408;return r=r-div(3*div(e+100100+div(t-8,6),100),4)+752}function d2g(e){var t,a,r,i;return t=(t=4*e+139361631)+4*div(3*div(4*e+183187720,146097),4)-3908,a=5*div(mod(t,1461),4)+308,r=div(mod(a,153),5)+1,i=mod(div(a,153),12)+1,{gy:div(t,1461)-100100+div(8-i,6),gm:i,gd:r}}function div(e,t){return~~(e/t)}function mod(e,t){return e-~~(e/t)*t}function fixDate(e,t,a){for(t>11&&(e+=Math.floor(t/12),t%=12);t<0;)e-=1,t+=12;for(;a>monthLength(e,t+1);)a-=monthLength(e=0===(t=11!==t?t+1:0)?e+1:e,t+1);for(;a<=0;)a+=monthLength(e=11===(t=0!==t?t-1:11)?e-1:e,t+1);return[e,t||0,a||1]}var methods=["getHours","getMilliseconds","getMinutes","getSeconds","getTime","getTimezoneOffset","getUTCDate","getUTCDay","getUTCFullYear","getUTCHours","getUTCMilliseconds","getUTCMinutes","getUTCMonth","getUTCSeconds","now","parse","setHours","setMilliseconds","setMinutes","setSeconds","setTime","setUTCDate","setUTCFullYear","setUTCHours","setUTCMilliseconds","setUTCMinutes","setUTCMonth","setUTCSeconds","toDateString","toISOString","toJSON","toLocaleDateString","toLocaleTimeString","toLocaleString","toTimeString","toUTCString","UTC","valueOf"],DAY_NAMES=["Shanbe","Yekshanbe","Doshanbe","Seshanbe","Chaharshanbe","Panjshanbe","Jom'e"],PERSIAN_DAY_NAMES=["شنبه","یکشنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنجشنبه","جمعه"],MONTH_NAMES=["Farvardin","Ordibehesht","Khordad","Tir","Mordad","Shahrivar","Mehr","Aban","Azar","Dey","Bahman","Esfand"],PERSIAN_MONTH_NAMES=["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"],PERSIAN_NUMBERS=["۰","۱","۲","۳","۴","۵","۶","۷","۸","۹"],IDate=function(e){function t(){for(var a,r=[],i=arguments.length;i--;)r[i]=arguments[i];if(e.call(this),0===r.length)a=e.now();else if(1===r.length)a=r[0]instanceof e?r[0].getTime():r[0];else{var n=fixDate(r[0],r[1]||0,void 0===r[2]?1:r[2]),s=toGregorian(n[0],n[1]+1,n[2]);a=[s.gy,s.gm-1,s.gd].concat([r[3]||0,r[4]||0,r[5]||0,r[6]||0])}Array.isArray(a)?this.gdate=new(Function.prototype.bind.apply(e,[null].concat(a))):this.gdate=new e(a);var o=toJalaali(this.gdate.getFullYear(),this.gdate.getMonth()+1,this.gdate.getDate());this.jdate=[o.jy,o.jm-1,o.jd],methods.forEach(function(e){t.prototype[e]=function(){var t;return(t=this.gdate)[e].apply(t,arguments)}})}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.getFullYear=function(){return this.jdate[0]},t.prototype.setFullYear=function(e){return this.jdate=fixDate(e,this.jdate[1],this.jdate[2]),this.syncDate(),this.gdate.getTime()},t.prototype.getMonth=function(){return this.jdate[1]},t.prototype.setMonth=function(e){return this.jdate=fixDate(this.jdate[0],e,this.jdate[2]),this.syncDate(),this.gdate.getTime()},t.prototype.getDate=function(){return this.jdate[2]},t.prototype.setDate=function(e){return this.jdate=fixDate(this.jdate[0],this.jdate[1],e),this.syncDate(),this.gdate.getTime()},t.prototype.getDay=function(){return(this.gdate.getDay()+1)%7},t.prototype.syncDate=function(){var e=toGregorian(this.jdate[0],this.jdate[1]+1,this.jdate[2]);this.gdate.setFullYear(e.gy),this.gdate.setMonth(e.gm-1),this.gdate.setDate(e.gd)},t.prototype.toString=function(e){void 0===e&&(e=!0);var t=function(e){return 1===e.toString().length?"0"+e:e.toString()},a=t(this.getHours())+":"+t(this.getMinutes())+":"+t(this.getSeconds());return e?(PERSIAN_DAY_NAMES[this.getDay()]+" "+this.getDate()+" "+PERSIAN_MONTH_NAMES[this.getMonth()]+" "+this.getFullYear()+" ساعت "+a).replace(/./g,function(e){return PERSIAN_NUMBERS[e]||e}):DAY_NAMES[this.getDay()]+" "+this.getDate()+" "+MONTH_NAMES[this.getMonth()]+" "+this.getFullYear()+" "+a},t}(Date),Calendar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i,n,s=this;if(s.params=Utils.extend({},t.params.calendar,a),"jalali"===s.params.calendarType&&Object.keys(s.params.jalali).forEach(function(e){a[e]||(s.params[e]=s.params.jalali[e])}),"jalali"===s.params.calendarType?s.DateHandleClass=IDate:s.DateHandleClass=Date,s.params.containerEl&&0===(r=$(s.params.containerEl)).length)return s;s.params.inputEl&&(i=$(s.params.inputEl)),i&&(n=i.parents(".view").length&&i.parents(".view")[0].f7View),n||(n=t.views.main);var o="horizontal"===s.params.direction,l=1;function p(){s.open()}function c(e){e.preventDefault()}function d(e){var t=$(e.target);!s.destroyed&&s.params&&(s.isPopover()||s.opened&&!s.closing&&(t.closest('[class*="backdrop"]').length||(i&&i.length>0?t[0]!==i[0]&&0===t.closest(".sheet-modal, .calendar-modal").length&&s.close():0===$(e.target).closest(".sheet-modal, .calendar-modal").length&&s.close())))}return o&&(l=t.rtl?-1:1),Utils.extend(s,{app:t,$containerEl:r,containerEl:r&&r[0],inline:r&&r.length>0,$inputEl:i,inputEl:i&&i[0],initialized:!1,opened:!1,url:s.params.url,isHorizontal:o,inverter:l,view:n,animating:!1}),Utils.extend(s,{attachInputEvents:function(){s.$inputEl.on("click",p),s.params.inputReadOnly&&s.$inputEl.on("focus mousedown",c)},detachInputEvents:function(){s.$inputEl.off("click",p),s.params.inputReadOnly&&s.$inputEl.off("focus mousedown",c)},attachHtmlEvents:function(){t.on("click",d)},detachHtmlEvents:function(){t.off("click",d)}}),s.attachCalendarEvents=function(){var e,a,r,i,n,o,l,p,c,d,u,h,f,v=!0,m=s.$el,g=s.$wrapperEl;function b(t){a||e||(e=!0,r="touchstart"===t.type?t.targetTouches[0].pageX:t.pageX,n=r,i="touchstart"===t.type?t.targetTouches[0].pageY:t.pageY,o=i,l=(new s.DateHandleClass).getTime(),u=0,v=!0,f=void 0,p=s.monthsTranslate)}function y(t){if(e){var l=s.isHorizontal;n="touchmove"===t.type?t.targetTouches[0].pageX:t.pageX,o="touchmove"===t.type?t.targetTouches[0].pageY:t.pageY,void 0===f&&(f=!!(f||Math.abs(o-i)>Math.abs(n-r))),l&&f?e=!1:(t.preventDefault(),s.animating?e=!1:(v=!1,a||(a=!0,c=g[0].offsetWidth,d=g[0].offsetHeight,g.transition(0)),u=(h=l?n-r:o-i)/(l?c:d),p=100*(s.monthsTranslate*s.inverter+u),g.transform("translate3d("+(l?p:0)+"%, "+(l?0:p)+"%, 0)")))}}function w(){if(!e||!a)return e=!1,void(a=!1);e=!1,a=!1,(new s.DateHandleClass).getTime()-l<300?Math.abs(h)<10?s.resetMonth():h>=10?t.rtl?s.nextMonth():s.prevMonth():t.rtl?s.prevMonth():s.nextMonth():u<=-.5?t.rtl?s.prevMonth():s.nextMonth():u>=.5?t.rtl?s.nextMonth():s.prevMonth():s.resetMonth(),setTimeout(function(){v=!0},100)}function C(e){if(v){var t=$(e.target).parents(".calendar-day");if(0===t.length&&$(e.target).hasClass("calendar-day")&&(t=$(e.target)),0!==t.length&&!t.hasClass("calendar-day-disabled")){s.params.rangePicker||(t.hasClass("calendar-day-next")&&s.nextMonth(),t.hasClass("calendar-day-prev")&&s.prevMonth());var a=parseInt(t.attr("data-year"),10),r=parseInt(t.attr("data-month"),10),i=parseInt(t.attr("data-day"),10);s.emit("local::dayClick calendarDayClick",s,t[0],a,r,i),(!t.hasClass("calendar-day-selected")||s.params.multiple||s.params.rangePicker)&&s.addValue(new s.DateHandleClass(a,r,i,0,0,0)),s.params.closeOnSelect&&(s.params.rangePicker&&2===s.value.length||!s.params.rangePicker)&&s.close()}}}function x(){s.nextMonth()}function k(){s.prevMonth()}function E(){s.nextYear()}function S(){s.prevYear()}var T=!("touchstart"!==t.touchEvents.start||!t.support.passiveListener)&&{passive:!0,capture:!1};m.find(".calendar-prev-month-button").on("click",k),m.find(".calendar-next-month-button").on("click",x),m.find(".calendar-prev-year-button").on("click",S),m.find(".calendar-next-year-button").on("click",E),g.on("click",C),s.params.touchMove&&(g.on(t.touchEvents.start,b,T),t.on("touchmove:active",y),t.on("touchend:passive",w)),s.detachCalendarEvents=function(){m.find(".calendar-prev-month-button").off("click",k),m.find(".calendar-next-month-button").off("click",x),m.find(".calendar-prev-year-button").off("click",S),m.find(".calendar-next-year-button").off("click",E),g.off("click",C),s.params.touchMove&&(g.off(t.touchEvents.start,b,T),t.off("touchmove:active",y),t.off("touchend:passive",w))}},s.init(),s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.normalizeDate=function(e){var t=new this.DateHandleClass(e);return new this.DateHandleClass(t.getFullYear(),t.getMonth(),t.getDate())},t.prototype.normalizeValues=function(e){var t=this,a=[];return e&&Array.isArray(e)&&(a=e.map(function(e){return t.normalizeDate(e)})),a},t.prototype.initInput=function(){this.$inputEl&&this.params.inputReadOnly&&this.$inputEl.prop("readOnly",!0)},t.prototype.isPopover=function(){var e=this.app,t=this.modal,a=this.params;if("sheet"===a.openIn)return!1;if(t&&"popover"!==t.type)return!1;if(!this.inline&&this.inputEl){if("popover"===a.openIn)return!0;if(e.device.ios)return!!e.device.ipad;if(e.width>=768)return!0;if(e.device.desktop&&"aurora"===e.theme)return!0}return!1},t.prototype.formatDate=function(e){var t=new this.DateHandleClass(e),a=t.getFullYear(),r=t.getMonth(),i=r+1,n=t.getDate(),s=t.getDay(),o=this.params,l=o.dateFormat,p=o.monthNames,c=o.monthNamesShort,d=o.dayNames,u=o.dayNamesShort;return l.replace(/yyyy/g,a).replace(/yy/g,String(a).substring(2)).replace(/mm/g,i<10?"0"+i:i).replace(/m(\W+)/g,i+"$1").replace(/MM/g,p[r]).replace(/M(\W+)/g,c[r]+"$1").replace(/dd/g,n<10?"0"+n:n).replace(/d(\W+)/g,n+"$1").replace(/DD/g,d[s]).replace(/D(\W+)/g,u[s]+"$1")},t.prototype.formatValue=function(){var e=this,t=e.value;return e.params.formatValue?e.params.formatValue.call(e,t):t.map(function(t){return e.formatDate(t)}).join(e.params.rangePicker?" - ":", ")},t.prototype.addValue=function(e){var t=this.params,a=t.multiple,r=t.rangePicker,i=t.rangePickerMinDays,n=t.rangePickerMaxDays;if(a){var s;this.value||(this.value=[]);for(var o=0;o<this.value.length;o+=1)new this.DateHandleClass(e).getTime()===new this.DateHandleClass(this.value[o]).getTime()&&(s=o);void 0===s?this.value.push(e):this.value.splice(s,1),this.updateValue()}else r?(this.value||(this.value=[]),2!==this.value.length&&0!==this.value.length||(this.value=[]),0===this.value.length||Math.abs(this.value[0].getTime()-e.getTime())>=60*(i-1)*60*24*1e3&&(0===n||Math.abs(this.value[0].getTime()-e.getTime())<=60*(n-1)*60*24*1e3)?this.value.push(e):this.value=[],this.value.sort(function(e,t){return e-t}),this.updateValue()):(this.value=[e],this.updateValue())},t.prototype.setValue=function(e){var t=this.value;if(Array.isArray(t)&&Array.isArray(e)&&t.length===e.length){var a=!0;if(t.forEach(function(t,r){t!==e[r]&&(a=!1)}),a)return}this.value=e,this.updateValue()},t.prototype.getValue=function(){return this.value},t.prototype.updateValue=function(e){var t,a,r=this.$el,i=this.$wrapperEl,n=this.$inputEl,s=this.value,o=this.params;if(r&&r.length>0)if(i.find(".calendar-day-selected").removeClass("calendar-day-selected"),o.rangePicker&&2===s.length)for(t=new this.DateHandleClass(s[0]).getTime();t<=new this.DateHandleClass(s[1]).getTime();t+=864e5)a=new this.DateHandleClass(t),i.find('.calendar-day[data-date="'+a.getFullYear()+"-"+a.getMonth()+"-"+a.getDate()+'"]').addClass("calendar-day-selected");else for(t=0;t<this.value.length;t+=1)a=new this.DateHandleClass(s[t]),i.find('.calendar-day[data-date="'+a.getFullYear()+"-"+a.getMonth()+"-"+a.getDate()+'"]').addClass("calendar-day-selected");if(e||this.emit("local::change calendarChange",this,s),n&&n.length||o.header){var l=this.formatValue(s);o.header&&r&&r.length&&r.find(".calendar-selected-date").text(l),n&&n.length&&!e&&(n.val(l),n.trigger("change"))}},t.prototype.updateCurrentMonthYear=function(e){var t=this.$months,a=this.$el,r=this.params;void 0===e?(this.currentMonth=parseInt(t.eq(1).attr("data-month"),10),this.currentYear=parseInt(t.eq(1).attr("data-year"),10)):(this.currentMonth=parseInt(t.eq("next"===e?t.length-1:0).attr("data-month"),10),this.currentYear=parseInt(t.eq("next"===e?t.length-1:0).attr("data-year"),10)),a.find(".current-month-value").text(r.monthNames[this.currentMonth]),a.find(".current-year-value").text(this.currentYear)},t.prototype.update=function(){var e=this,t=e.currentYear,a=e.currentMonth,r=e.$wrapperEl,i=new e.DateHandleClass(t,a),n=e.renderMonth(i,"prev"),s=e.renderMonth(i),o=e.renderMonth(i,"next");r.transition(0).html(""+n+s+o).transform("translate3d(0,0,0)"),e.$months=r.find(".calendar-month"),e.monthsTranslate=0,e.setMonthsTranslate(),e.$months.each(function(t,a){e.emit("local::monthAdd calendarMonthAdd",a)})},t.prototype.onMonthChangeStart=function(e){var t=this.$months,a=this.currentYear,r=this.currentMonth;this.updateCurrentMonthYear(e),t.removeClass("calendar-month-current calendar-month-prev calendar-month-next");var i="next"===e?t.length-1:0;t.eq(i).addClass("calendar-month-current"),t.eq("next"===e?i-1:i+1).addClass("next"===e?"calendar-month-prev":"calendar-month-next"),this.emit("local::monthYearChangeStart calendarMonthYearChangeStart",this,a,r)},t.prototype.onMonthChangeEnd=function(e,t){var a,r,i,n=this.currentYear,s=this.currentMonth,o=this.$wrapperEl,l=this.monthsTranslate;this.animating=!1,o.find(".calendar-month:not(.calendar-month-prev):not(.calendar-month-current):not(.calendar-month-next)").remove(),void 0===e&&(e="next",t=!0),t?(o.find(".calendar-month-next, .calendar-month-prev").remove(),r=this.renderMonth(new this.DateHandleClass(n,s),"prev"),a=this.renderMonth(new this.DateHandleClass(n,s),"next")):i=this.renderMonth(new this.DateHandleClass(n,s),e),("next"===e||t)&&o.append(i||a),("prev"===e||t)&&o.prepend(i||r);var p=o.find(".calendar-month");this.$months=p,this.setMonthsTranslate(l),this.emit("local::monthAdd calendarMonthAdd",this,"next"===e?p.eq(p.length-1)[0]:p.eq(0)[0]),this.emit("local::monthYearChangeEnd calendarMonthYearChangeEnd",this,n,s)},t.prototype.setMonthsTranslate=function(e){var t=this.$months,a=this.isHorizontal,r=this.inverter;e=e||this.monthsTranslate||0,void 0===this.monthsTranslate&&(this.monthsTranslate=e),t.removeClass("calendar-month-current calendar-month-prev calendar-month-next");var i=100*-(e+1)*r,n=100*-e*r,s=100*-(e-1)*r;t.eq(0).transform("translate3d("+(a?i:0)+"%, "+(a?0:i)+"%, 0)").addClass("calendar-month-prev"),t.eq(1).transform("translate3d("+(a?n:0)+"%, "+(a?0:n)+"%, 0)").addClass("calendar-month-current"),t.eq(2).transform("translate3d("+(a?s:0)+"%, "+(a?0:s)+"%, 0)").addClass("calendar-month-next")},t.prototype.nextMonth=function(e){var t=this,a=t.params,r=t.$wrapperEl,i=t.inverter,n=t.isHorizontal;void 0!==e&&"object"!=typeof e||(e="",a.animate||(e=0));var s=parseInt(t.$months.eq(t.$months.length-1).attr("data-month"),10),o=parseInt(t.$months.eq(t.$months.length-1).attr("data-year"),10),l=new t.DateHandleClass(o,s).getTime(),p=!t.animating;if(a.maxDate&&l>new t.DateHandleClass(a.maxDate).getTime())t.resetMonth();else{if(t.monthsTranslate-=1,s===t.currentMonth){var c=100*-t.monthsTranslate*i,d=$(t.renderMonth(l,"next")).transform("translate3d("+(n?c:0)+"%, "+(n?0:c)+"%, 0)").addClass("calendar-month-next");r.append(d[0]),t.$months=r.find(".calendar-month"),t.emit("local::monthAdd calendarMonthAdd",t.$months.eq(t.$months.length-1)[0])}t.animating=!0,t.onMonthChangeStart("next");var u=100*t.monthsTranslate*i;r.transition(e).transform("translate3d("+(n?u:0)+"%, "+(n?0:u)+"%, 0)"),p&&r.transitionEnd(function(){t.onMonthChangeEnd("next")}),a.animate||t.onMonthChangeEnd("next")}},t.prototype.prevMonth=function(e){var t=this,a=t.params,r=t.$wrapperEl,i=t.inverter,n=t.isHorizontal;void 0!==e&&"object"!=typeof e||(e="",a.animate||(e=0));var s=parseInt(t.$months.eq(0).attr("data-month"),10),o=parseInt(t.$months.eq(0).attr("data-year"),10),l=new t.DateHandleClass(o,s+1,-1).getTime(),p=!t.animating;if(a.minDate){var c=new t.DateHandleClass(a.minDate);if(l<(c=new t.DateHandleClass(c.getFullYear(),c.getMonth(),1)).getTime())return void t.resetMonth()}if(t.monthsTranslate+=1,s===t.currentMonth){var d=100*-t.monthsTranslate*i,u=$(t.renderMonth(l,"prev")).transform("translate3d("+(n?d:0)+"%, "+(n?0:d)+"%, 0)").addClass("calendar-month-prev");r.prepend(u[0]),t.$months=r.find(".calendar-month"),t.emit("local::monthAdd calendarMonthAdd",t.$months.eq(0)[0])}t.animating=!0,t.onMonthChangeStart("prev");var h=100*t.monthsTranslate*i;r.transition(e).transform("translate3d("+(n?h:0)+"%, "+(n?0:h)+"%, 0)"),p&&r.transitionEnd(function(){t.onMonthChangeEnd("prev")}),a.animate||t.onMonthChangeEnd("prev")},t.prototype.resetMonth=function(e){void 0===e&&(e="");var t=this.$wrapperEl,a=this.inverter,r=this.isHorizontal,i=100*this.monthsTranslate*a;t.transition(e).transform("translate3d("+(r?i:0)+"%, "+(r?0:i)+"%, 0)")},t.prototype.setYearMonth=function(e,t,a){var r,i=this,n=i.params,s=i.isHorizontal,o=i.$wrapperEl,l=i.inverter;if(void 0===e&&(e=i.currentYear),void 0===t&&(t=i.currentMonth),void 0!==a&&"object"!=typeof a||(a="",n.animate||(a=0)),r=e<i.currentYear?new i.DateHandleClass(e,t+1,-1).getTime():new i.DateHandleClass(e,t).getTime(),n.maxDate&&r>new i.DateHandleClass(n.maxDate).getTime())return!1;if(n.minDate){var p=new i.DateHandleClass(n.minDate);if(r<(p=new i.DateHandleClass(p.getFullYear(),p.getMonth(),1)).getTime())return!1}var c=new i.DateHandleClass(i.currentYear,i.currentMonth).getTime(),d=r>c?"next":"prev",u=i.renderMonth(new i.DateHandleClass(e,t));i.monthsTranslate=i.monthsTranslate||0;var h,f=i.monthsTranslate,v=!i.animating;r>c?(i.monthsTranslate-=1,i.animating||i.$months.eq(i.$months.length-1).remove(),o.append(u),i.$months=o.find(".calendar-month"),h=100*-(f-1)*l,i.$months.eq(i.$months.length-1).transform("translate3d("+(s?h:0)+"%, "+(s?0:h)+"%, 0)").addClass("calendar-month-next")):(i.monthsTranslate+=1,i.animating||i.$months.eq(0).remove(),o.prepend(u),i.$months=o.find(".calendar-month"),h=100*-(f+1)*l,i.$months.eq(0).transform("translate3d("+(s?h:0)+"%, "+(s?0:h)+"%, 0)").addClass("calendar-month-prev")),i.emit("local::monthAdd calendarMonthAdd","next"===d?i.$months.eq(i.$months.length-1)[0]:i.$months.eq(0)[0]),i.animating=!0,i.onMonthChangeStart(d);var m=100*i.monthsTranslate*l;o.transition(a).transform("translate3d("+(s?m:0)+"%, "+(s?0:m)+"%, 0)"),v&&o.transitionEnd(function(){i.onMonthChangeEnd(d,!0)}),n.animate||i.onMonthChangeEnd(d)},t.prototype.nextYear=function(){this.setYearMonth(this.currentYear+1)},t.prototype.prevYear=function(){this.setYearMonth(this.currentYear-1)},t.prototype.dateInRange=function(e,t){var a,r=!1;if(!t)return!1;if(Array.isArray(t))for(a=0;a<t.length;a+=1)t[a].from||t[a].to?t[a].from&&t[a].to?e<=new this.DateHandleClass(t[a].to).getTime()&&e>=new this.DateHandleClass(t[a].from).getTime()&&(r=!0):t[a].from?e>=new this.DateHandleClass(t[a].from).getTime()&&(r=!0):t[a].to&&e<=new this.DateHandleClass(t[a].to).getTime()&&(r=!0):t[a].date?e===new this.DateHandleClass(t[a].date).getTime()&&(r=!0):e===new this.DateHandleClass(t[a]).getTime()&&(r=!0);else t.from||t.to?t.from&&t.to?e<=new this.DateHandleClass(t.to).getTime()&&e>=new this.DateHandleClass(t.from).getTime()&&(r=!0):t.from?e>=new this.DateHandleClass(t.from).getTime()&&(r=!0):t.to&&e<=new this.DateHandleClass(t.to).getTime()&&(r=!0):t.date?r=e===new this.DateHandleClass(t.date).getTime():"function"==typeof t&&(r=t(new this.DateHandleClass(e)));return r},t.prototype.daysInMonth=function(e){var t=new this.DateHandleClass(e);return new this.DateHandleClass(t.getFullYear(),t.getMonth()+1,0).getDate()},t.prototype.renderMonths=function(e){return this.params.renderMonths?this.params.renderMonths.call(this,e):('\n    <div class="calendar-months-wrapper">\n    '+this.renderMonth(e,"prev")+"\n    "+this.renderMonth(e)+"\n    "+this.renderMonth(e,"next")+"\n    </div>\n  ").trim()},t.prototype.renderMonth=function(e,t){var a=this,r=a.params,i=a.value;if(r.renderMonth)return r.renderMonth.call(a,e,t);var n=new a.DateHandleClass(e),s=n.getFullYear(),o=n.getMonth();"next"===t&&(n=11===o?new a.DateHandleClass(s+1,0):new a.DateHandleClass(s,o+1,1)),"prev"===t&&(n=0===o?new a.DateHandleClass(s-1,11):new a.DateHandleClass(s,o-1,1)),"next"!==t&&"prev"!==t||(o=n.getMonth(),s=n.getFullYear());var l,p,c=[],d=(new a.DateHandleClass).setHours(0,0,0,0),u=r.minDate?new a.DateHandleClass(r.minDate).getTime():null,h=r.maxDate?new a.DateHandleClass(r.maxDate).getTime():null,f=a.daysInMonth(new a.DateHandleClass(n.getFullYear(),n.getMonth()).getTime()-864e6),v=a.daysInMonth(n),m=6===r.firstDay?0:1,g="",b=r.firstDay-1+0,y=new a.DateHandleClass(n.getFullYear(),n.getMonth()).getDay();if(0===y&&(y=7),i&&i.length)for(var w=0;w<i.length;w+=1)c.push(new a.DateHandleClass(i[w]).setHours(0,0,0,0));for(var C=1;C<=6;C+=1){for(var x="",$=function(e){var t=void 0,i=(b+=1)-y,n="";1===C&&1===e&&i>m&&1!==r.firstDay&&(i=(b-=7)-y);var g=e-1+r.firstDay>6?e-1-7+r.firstDay:e-1+r.firstDay;i<0?(i=f+i+1,n+=" calendar-day-prev",t=new a.DateHandleClass(o-1<0?s-1:s,o-1<0?11:o-1,i).getTime()):(i+=1)>v?(i-=v,n+=" calendar-day-next",t=new a.DateHandleClass(o+1>11?s+1:s,o+1>11?0:o+1,i).getTime()):t=new a.DateHandleClass(s,o,i).getTime(),t===d&&(n+=" calendar-day-today"),r.rangePicker&&2===c.length?t>=c[0]&&t<=c[1]&&(n+=" calendar-day-selected"):c.indexOf(t)>=0&&(n+=" calendar-day-selected"),r.weekendDays.indexOf(g)>=0&&(n+=" calendar-day-weekend");var w="";if(p=!1,r.events&&a.dateInRange(t,r.events)&&(p=!0),p&&(n+=" calendar-day-has-events",w='\n            <span class="calendar-day-events">\n              <span class="calendar-day-event"></span>\n            </span>\n          ',Array.isArray(r.events))){var $=[];r.events.forEach(function(e){var r=e.color||"";$.indexOf(r)<0&&a.dateInRange(t,e)&&$.push(r)}),w='\n              <span class="calendar-day-events">\n                '+$.map(function(e){return('\n                  <span class="calendar-day-event" style="'+(e?"background-color: "+e:"")+'"></span>\n                ').trim()}).join("")+"\n              </span>\n            "}if(r.rangesClasses)for(var k=0;k<r.rangesClasses.length;k+=1)a.dateInRange(t,r.rangesClasses[k].range)&&(n+=" "+r.rangesClasses[k].cssClass);l=!1,(u&&t<u||h&&t>h)&&(l=!0),r.disabled&&a.dateInRange(t,r.disabled)&&(l=!0),l&&(n+=" calendar-day-disabled");var E=(t=new a.DateHandleClass(t)).getFullYear(),S=t.getMonth();x+=('\n          <div data-year="'+E+'" data-month="'+S+'" data-day="'+i+'" class="calendar-day'+n+'" data-date="'+E+"-"+S+"-"+i+'">\n            <span class="calendar-day-number">'+i+w+"</span>\n          </div>").trim()},k=1;k<=7;k+=1)$(k);g+='<div class="calendar-row">'+x+"</div>"}return g='<div class="calendar-month" data-year="'+s+'" data-month="'+o+'">'+g+"</div>"},t.prototype.renderWeekHeader=function(){if(this.params.renderWeekHeader)return this.params.renderWeekHeader.call(this);for(var e=this.params,t="",a=0;a<7;a+=1){var r=a+e.firstDay>6?a-7+e.firstDay:a+e.firstDay;t+='<div class="calendar-week-day">'+e.dayNamesShort[r]+"</div>"}return('\n    <div class="calendar-week-header">\n      '+t+"\n    </div>\n  ").trim()},t.prototype.renderMonthSelector=function(){return this.params.renderMonthSelector?this.params.renderMonthSelector.call(this):'\n    <div class="calendar-month-selector">\n      <a class="link icon-only calendar-prev-month-button">\n        <i class="icon icon-prev"></i>\n      </a>\n      <span class="current-month-value"></span>\n      <a class="link icon-only calendar-next-month-button">\n        <i class="icon icon-next"></i>\n      </a>\n    </div>\n  '.trim()},t.prototype.renderYearSelector=function(){return this.params.renderYearSelector?this.params.renderYearSelector.call(this):'\n    <div class="calendar-year-selector">\n      <a class="link icon-only calendar-prev-year-button">\n        <i class="icon icon-prev"></i>\n      </a>\n      <span class="current-year-value"></span>\n      <a class="link icon-only calendar-next-year-button">\n        <i class="icon icon-next"></i>\n      </a>\n    </div>\n  '.trim()},t.prototype.renderHeader=function(){return this.params.renderHeader?this.params.renderHeader.call(this):('\n    <div class="calendar-header">\n      <div class="calendar-selected-date">'+this.params.headerPlaceholder+"</div>\n    </div>\n  ").trim()},t.prototype.renderFooter=function(){var e=this.app;return this.params.renderFooter?this.params.renderFooter.call(this):('\n    <div class="calendar-footer">\n      <a class="'+("md"===e.theme?"button":"link")+' calendar-close sheet-close popover-close">'+this.params.toolbarCloseText+"</a>\n    </div>\n  ").trim()},t.prototype.renderToolbar=function(){return this.params.renderToolbar?this.params.renderToolbar.call(this,this):('\n    <div class="toolbar toolbar-top no-shadow">\n      <div class="toolbar-inner">\n        '+(this.params.monthSelector?this.renderMonthSelector():"")+"\n        "+(this.params.yearSelector?this.renderYearSelector():"")+"\n      </div>\n    </div>\n  ").trim()},t.prototype.renderInline=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,i=e.footer,n=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="calendar calendar-inline '+(n?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(i?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderCustomModal=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,i=e.footer,n=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="calendar calendar-modal '+(n?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(i?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderSheet=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,i=e.footer,n=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="sheet-modal calendar calendar-sheet '+(n?"calendar-range":"")+" "+(t||"")+'">\n      '+(r?this.renderHeader():"")+"\n      "+(a?this.renderToolbar():"")+"\n      "+(s?this.renderWeekHeader():"")+'\n      <div class="sheet-modal-inner calendar-months">\n        '+this.renderMonths(l)+"\n      </div>\n      "+(i?this.renderFooter():"")+"\n    </div>\n  ").trim()},t.prototype.renderPopover=function(){var e=this.params,t=e.cssClass,a=e.toolbar,r=e.header,i=e.footer,n=e.rangePicker,s=e.weekHeader,o=this.value,l=o&&o.length?o[0]:(new this.DateHandleClass).setHours(0,0,0);return('\n    <div class="popover calendar-popover">\n      <div class="popover-inner">\n        <div class="calendar '+(n?"calendar-range":"")+" "+(t||"")+'">\n        '+(r?this.renderHeader():"")+"\n        "+(a?this.renderToolbar():"")+"\n        "+(s?this.renderWeekHeader():"")+'\n        <div class="calendar-months">\n          '+this.renderMonths(l)+"\n        </div>\n        "+(i?this.renderFooter():"")+"\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.render=function(){var e=this.params;if(e.render)return e.render.call(this);if(!this.inline){var t=e.openIn;return"auto"===t&&(t=this.isPopover()?"popover":"sheet"),"popover"===t?this.renderPopover():"sheet"===t?this.renderSheet():this.renderCustomModal()}return this.renderInline()},t.prototype.onOpen=function(){var e=this,t=e.initialized,a=e.$el,r=e.app,i=e.$inputEl,n=e.inline,s=e.value,o=e.params;e.closing=!1,e.opened=!0,e.opening=!0,e.attachCalendarEvents();var l=!s&&o.value;t?s&&e.setValue(s,0):s?e.setValue(s,0):o.value&&e.setValue(e.normalizeValues(o.value),0),e.updateCurrentMonthYear(),e.monthsTranslate=0,e.setMonthsTranslate(),l?e.updateValue():o.header&&s&&e.updateValue(!0),!n&&i&&i.length&&"md"===r.theme&&i.trigger("focus"),e.initialized=!0,e.$months.each(function(t,a){e.emit("local::monthAdd calendarMonthAdd",a)}),a&&a.trigger("calendar:open",e),i&&i.trigger("calendar:open",e),e.emit("local::open calendarOpen",e)},t.prototype.onOpened=function(){this.opening=!1,this.$el&&this.$el.trigger("calendar:opened",this),this.$inputEl&&this.$inputEl.trigger("calendar:opened",this),this.emit("local::opened calendarOpened",this)},t.prototype.onClose=function(){var e=this.app;this.opening=!1,this.closing=!0,this.$inputEl&&"md"===e.theme&&this.$inputEl.trigger("blur"),this.detachCalendarEvents&&this.detachCalendarEvents(),this.$el&&this.$el.trigger("calendar:close",this),this.$inputEl&&this.$inputEl.trigger("calendar:close",this),this.emit("local::close calendarClose",this)},t.prototype.onClosed=function(){var e=this;e.opened=!1,e.closing=!1,e.inline||Utils.nextTick(function(){e.modal&&e.modal.el&&e.modal.destroy&&(e.params.routableModals||e.modal.destroy()),delete e.modal}),e.$el&&e.$el.trigger("calendar:closed",e),e.$inputEl&&e.$inputEl.trigger("calendar:closed",e),e.emit("local::closed calendarClosed",e)},t.prototype.open=function(){var e,t=this,a=t.app,r=t.opened,i=t.inline,n=t.$inputEl,s=t.params;if(!r){if(i)return t.$el=$(t.render()),t.$el[0].f7Calendar=t,t.$wrapperEl=t.$el.find(".calendar-months-wrapper"),t.$months=t.$wrapperEl.find(".calendar-month"),t.$containerEl.append(t.$el),t.onOpen(),void t.onOpened();var o=s.openIn;"auto"===o&&(o=t.isPopover()?"popover":"sheet");var l=t.render(),p={targetEl:n,scrollToEl:t.params.scrollToInput?n:void 0,content:l,backdrop:!0===t.params.backdrop||"popover"===o&&!1!==a.params.popover.backdrop&&!1!==t.params.backdrop,closeByBackdropClick:t.params.closeByBackdropClick,on:{open:function(){t.modal=this,t.$el="popover"===o?this.$el.find(".calendar"):this.$el,t.$wrapperEl=t.$el.find(".calendar-months-wrapper"),t.$months=t.$wrapperEl.find(".calendar-month"),t.$el[0].f7Calendar=t,"customModal"===o&&$(t.$el).find(".calendar-close").once("click",function(){t.close()}),t.onOpen()},opened:function(){t.onOpened()},close:function(){t.onClose()},closed:function(){t.onClosed()}}};t.params.routableModals?t.view.router.navigate({url:t.url,route:(e={path:t.url},e[o]=p,e)}):(t.modal=a[o].create(p),t.modal.open())}},t.prototype.close=function(){var e=this.opened,t=this.inline;if(e)return t?(this.onClose(),void this.onClosed()):void(this.params.routableModals?this.view.router.back():this.modal.close())},t.prototype.init=function(){if(this.initInput(),this.inline)return this.open(),void this.emit("local::init calendarInit",this);!this.initialized&&this.params.value&&this.setValue(this.normalizeValues(this.params.value)),this.$inputEl&&this.attachInputEvents(),this.params.closeByOutsideClick&&this.attachHtmlEvents(),this.emit("local::init calendarInit",this)},t.prototype.destroy=function(){if(!this.destroyed){var e=this.$el;this.emit("local::beforeDestroy calendarBeforeDestroy",this),e&&e.trigger("calendar:beforedestroy",this),this.close(),this.$inputEl&&this.detachInputEvents(),this.params.closeByOutsideClick&&this.detachHtmlEvents(),e&&e.length&&delete this.$el[0].f7Calendar,Utils.deleteProps(this),this.destroyed=!0}},t}(Framework7Class),Calendar$1={name:"calendar",static:{Calendar:Calendar},create:function(){this.calendar=ConstructorMethods({defaultSelector:".calendar",constructor:Calendar,app:this,domProp:"f7Calendar"}),this.calendar.close=function(e){void 0===e&&(e=".calendar");var t=$(e);if(0!==t.length){var a=t[0].f7Calendar;!a||a&&!a.opened||a.close()}}},params:{calendar:{calendarType:"gregorian",monthNames:["January","February","March","April","May","June","July","August","September","October","November","December"],monthNamesShort:["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],dayNames:["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"],dayNamesShort:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],firstDay:1,weekendDays:[0,6],jalali:{monthNames:["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"],monthNamesShort:["فَر","اُر","خُر","تیر","مُر","شَه","مهر","آب","آذر","دی","بَه","اِس"],dayNames:["یک‌شنبه","دوشنبه","سه‌شنبه","چهارشنبه","پنج‌شنبه","جمعه","شنبه"],dayNamesShort:["1ش","۲ش","۳ش","۴ش","۵ش","ج","ش"],firstDay:6,weekendDays:[5]},multiple:!1,rangePicker:!1,rangePickerMinDays:1,rangePickerMaxDays:0,dateFormat:"yyyy-mm-dd",direction:"horizontal",minDate:null,maxDate:null,disabled:null,events:null,rangesClasses:null,touchMove:!0,animate:!0,closeOnSelect:!1,monthSelector:!0,yearSelector:!0,weekHeader:!0,value:null,containerEl:null,openIn:"auto",formatValue:null,inputEl:null,inputReadOnly:!0,closeByOutsideClick:!0,scrollToInput:!0,header:!1,headerPlaceholder:"Select date",footer:!1,toolbar:!0,toolbarCloseText:"Done",cssClass:null,routableModals:!0,view:null,url:"date/",backdrop:null,closeByBackdropClick:!0,renderWeekHeader:null,renderMonths:null,renderMonth:null,renderMonthSelector:null,renderYearSelector:null,renderHeader:null,renderFooter:null,renderToolbar:null,renderInline:null,renderPopover:null,renderSheet:null,render:null}}};function pickerColumn(e,t){var a=this,r=a.app,i=$(e),n=i.index(),s=a.cols[n];if(!s.divider){var o,l,p,c,d;s.$el=i,s.el=i[0],s.$itemsEl=s.$el.find(".picker-items"),s.items=s.$itemsEl.find(".picker-item"),s.replaceValues=function(e,t){s.detachEvents(),s.values=e,s.displayValues=t,s.$itemsEl.html(a.renderColumn(s,!0)),s.items=s.$itemsEl.find(".picker-item"),s.calcSize(),s.setValue(s.values[0],0,!0),s.attachEvents()},s.calcSize=function(){a.params.rotateEffect&&(s.$el.removeClass("picker-column-absolute"),s.width||s.$el.css({width:""}));var e=0,t=s.$el[0].offsetHeight;o=s.items[0].offsetHeight,l=o*s.items.length,p=t/2-l+o/2,c=t/2-o/2,s.width&&(e=s.width,parseInt(e,10)===e&&(e+="px"),s.$el.css({width:e})),a.params.rotateEffect&&(s.width||(s.items.each(function(t,a){var r=$(a).children("span");e=Math.max(e,r[0].offsetWidth)}),s.$el.css({width:e+2+"px"})),s.$el.addClass("picker-column-absolute"))},s.setValue=function(e,t,r){void 0===t&&(t="");var i=s.$itemsEl.find('.picker-item[data-picker-value="'+e+'"]').index();if(void 0!==i&&-1!==i){var n=-i*o+c;s.$itemsEl.transition(t),s.$itemsEl.transform("translate3d(0,"+n+"px,0)"),a.params.updateValuesOnMomentum&&s.activeIndex&&s.activeIndex!==i&&(Utils.cancelAnimationFrame(d),s.$itemsEl.transitionEnd(function(){Utils.cancelAnimationFrame(d)}),S()),s.updateItems(i,n,t,r)}},s.updateItems=function(e,t,r,i){void 0===t&&(t=Utils.getTranslate(s.$itemsEl[0],"y")),void 0===e&&(e=-Math.round((t-c)/o)),e<0&&(e=0),e>=s.items.length&&(e=s.items.length-1);var n=s.activeIndex;s.activeIndex=e,s.$itemsEl.find(".picker-item-selected").removeClass("picker-item-selected"),s.items.transition(r);var l=s.items.eq(e).addClass("picker-item-selected").transform("");a.params.rotateEffect&&s.items.each(function(e,r){var i=$(r),n=(i.index()*o-(c-t))/o,l=Math.ceil(s.height/o/2)+1,p=-18*n;p>180&&(p=180),p<-180&&(p=-180),Math.abs(n)>l?i.addClass("picker-item-far"):i.removeClass("picker-item-far"),i.transform("translate3d(0, "+(-t+c)+"px, "+(a.needsOriginFix?-110:0)+"px) rotateX("+p+"deg)")}),(i||void 0===i)&&(s.value=l.attr("data-picker-value"),s.displayValue=s.displayValues?s.displayValues[e]:s.value,n!==e&&(s.onChange&&s.onChange(a,s.value,s.displayValue),a.updateValue()))};var u,h,f,v,m,g,b,y,w,C,x,k=!0,E=!!r.support.passiveListener&&{passive:!1,capture:!1};s.attachEvents=function(){s.$el.on(r.touchEvents.start,T,E),r.on("touchmove:active",M),r.on("touchend:passive",P),a.params.mousewheel&&s.$el.on("wheel",O),s.items.on("click",D)},s.detachEvents=function(){s.$el.off(r.touchEvents.start,T,E),r.off("touchmove:active",M),r.off("touchend:passive",P),a.params.mousewheel&&s.$el.off("wheel",O),s.items.off("click",D)},s.init=function(){s.calcSize(),s.$itemsEl.transform("translate3d(0,"+c+"px,0)").transition(0),0===n&&s.$el.addClass("picker-column-first"),n===a.cols.length-1&&s.$el.addClass("picker-column-last"),t&&s.updateItems(0,c,0),s.attachEvents()},s.destroy=function(){s.detachEvents()},s.init()}function S(){d=Utils.requestAnimationFrame(function(){s.updateItems(void 0,void 0,0),S()})}function T(e){h||u||(e.preventDefault(),u=!0,f="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,v=f,m=(new Date).getTime(),k=!0,g=Utils.getTranslate(s.$itemsEl[0],"y"),y=g)}function M(e){u&&(e.preventDefault(),k=!1,v="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,h||(Utils.cancelAnimationFrame(d),h=!0,g=Utils.getTranslate(s.$itemsEl[0],"y"),y=g,s.$itemsEl.transition(0)),b=void 0,(y=g+(v-f))<p&&(y=p-Math.pow(p-y,.8),b="min"),y>c&&(y=c+Math.pow(y-c,.8),b="max"),s.$itemsEl.transform("translate3d(0,"+y+"px,0)"),s.updateItems(void 0,y,0,a.params.updateValuesOnTouchmove),C=y-w||y,w=y)}function P(){if(!u||!h)return u=!1,void(h=!1);var e;u=!1,h=!1,s.$itemsEl.transition(""),b&&("min"===b?s.$itemsEl.transform("translate3d(0,"+p+"px,0)"):s.$itemsEl.transform("translate3d(0,"+c+"px,0)")),e=(new Date).getTime()-m>300?y:y+C*a.params.momentumRatio,e=Math.max(Math.min(e,c),p);var t=Math.round(Math.abs((e-c)/o));a.params.freeMode||(e=-t*o+c),s.$itemsEl.transform("translate3d(0,"+parseInt(e,10)+"px,0)"),s.updateItems(t,e,"",!0),a.params.updateValuesOnMomentum&&(S(),s.$itemsEl.transitionEnd(function(){Utils.cancelAnimationFrame(d)})),setTimeout(function(){k=!0},100)}function O(e){var t=e.deltaX,r=e.deltaY;Math.abs(t)>Math.abs(r)||(clearTimeout(x),e.preventDefault(),Utils.cancelAnimationFrame(d),g=Utils.getTranslate(s.$itemsEl[0],"y"),s.$itemsEl.transition(0),b=void 0,(y=g-r)<p&&(y=p,b="min"),y>c&&(y=c,b="max"),s.$itemsEl.transform("translate3d(0,"+y+"px,0)"),s.updateItems(void 0,y,0,a.params.updateValuesOnMousewheel),x=setTimeout(function(){s.$itemsEl.transition(""),b&&("min"===b?s.$itemsEl.transform("translate3d(0,"+p+"px,0)"):s.$itemsEl.transform("translate3d(0,"+c+"px,0)")),(new Date).getTime();var e=y;e=Math.max(Math.min(e,c),p);var t=Math.round(Math.abs((e-c)/o));a.params.freeMode||(e=-t*o+c),s.$itemsEl.transform("translate3d(0,"+parseInt(e,10)+"px,0)"),s.updateItems(t,e,"",!0)},200))}function D(){if(k){Utils.cancelAnimationFrame(d);var e=$(this).attr("data-picker-value");s.setValue(e)}}}var Picker=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i,n,s=this;if(s.params=Utils.extend({},t.params.picker,a),s.params.containerEl&&0===(r=$(s.params.containerEl)).length)return s;function o(){s.resizeCols()}function l(){s.open()}function p(e){e.preventDefault()}function c(e){if(!s.destroyed&&s.params){var t=$(e.target);s.isPopover()||s.opened&&!s.closing&&(t.closest('[class*="backdrop"]').length||(i&&i.length>0?t[0]!==i[0]&&0===t.closest(".sheet-modal").length&&s.close():0===$(e.target).closest(".sheet-modal").length&&s.close()))}}return s.params.inputEl&&(i=$(s.params.inputEl)),i&&(n=i.parents(".view").length&&i.parents(".view")[0].f7View),n||(n=t.views.main),Utils.extend(s,{app:t,$containerEl:r,containerEl:r&&r[0],inline:r&&r.length>0,needsOriginFix:t.device.ios||win.navigator.userAgent.toLowerCase().indexOf("safari")>=0&&win.navigator.userAgent.toLowerCase().indexOf("chrome")<0&&!t.device.android,cols:[],$inputEl:i,inputEl:i&&i[0],initialized:!1,opened:!1,url:s.params.url,view:n}),Utils.extend(s,{attachResizeEvent:function(){t.on("resize",o)},detachResizeEvent:function(){t.off("resize",o)},attachInputEvents:function(){s.$inputEl.on("click",l),s.params.inputReadOnly&&s.$inputEl.on("focus mousedown",p)},detachInputEvents:function(){s.$inputEl.off("click",l),s.params.inputReadOnly&&s.$inputEl.off("focus mousedown",p)},attachHtmlEvents:function(){t.on("click",c)},detachHtmlEvents:function(){t.off("click",c)}}),s.init(),s}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.initInput=function(){this.$inputEl&&this.params.inputReadOnly&&this.$inputEl.prop("readOnly",!0)},t.prototype.resizeCols=function(){if(this.opened)for(var e=0;e<this.cols.length;e+=1)this.cols[e].divider||(this.cols[e].calcSize(),this.cols[e].setValue(this.cols[e].value,0,!1))},t.prototype.isPopover=function(){var e=this.app,t=this.modal,a=this.params;if("sheet"===a.openIn)return!1;if(t&&"popover"!==t.type)return!1;if(!this.inline&&this.inputEl){if("popover"===a.openIn)return!0;if(e.device.ios)return!!e.device.ipad;if(e.width>=768)return!0;if(e.device.desktop&&"aurora"===e.theme)return!0}return!1},t.prototype.formatValue=function(){var e=this.value,t=this.displayValue;return this.params.formatValue?this.params.formatValue.call(this,e,t):e.join(" ")},t.prototype.setValue=function(e,t){var a=0;if(0===this.cols.length)return this.value=e,void this.updateValue(e);for(var r=0;r<this.cols.length;r+=1)this.cols[r]&&!this.cols[r].divider&&(this.cols[r].setValue(e[a],t),a+=1)},t.prototype.getValue=function(){return this.value},t.prototype.updateValue=function(e){var t,a=e||[],r=[];if(0===this.cols.length)for(var i=this.params.cols.filter(function(e){return!e.divider}),n=0;n<i.length;n+=1)void 0!==(t=i[n]).displayValues&&void 0!==t.values&&-1!==t.values.indexOf(a[n])?r.push(t.displayValues[t.values.indexOf(a[n])]):r.push(a[n]);else for(var s=0;s<this.cols.length;s+=1)this.cols[s].divider||(a.push(this.cols[s].value),r.push(this.cols[s].displayValue));a.indexOf(void 0)>=0||(this.value=a,this.displayValue=r,this.emit("local::change pickerChange",this,this.value,this.displayValue),this.inputEl&&(this.$inputEl.val(this.formatValue()),this.$inputEl.trigger("change")))},t.prototype.initColumn=function(e,t){pickerColumn.call(this,e,t)},t.prototype.destroyColumn=function(e){var t=$(e).index();this.cols[t]&&this.cols[t].destroy&&this.cols[t].destroy()},t.prototype.renderToolbar=function(){return this.params.renderToolbar?this.params.renderToolbar.call(this,this):('\n      <div class="toolbar toolbar-top no-shadow">\n        <div class="toolbar-inner">\n          <div class="left"></div>\n          <div class="right">\n            <a class="link sheet-close popover-close">'+this.params.toolbarCloseText+"</a>\n          </div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderColumn=function(e,t){var a,r,i="picker-column "+(e.textAlign?"picker-column-"+e.textAlign:"")+" "+(e.cssClass||"");return a=e.divider?'\n        <div class="'+i+' picker-column-divider">'+e.content+"</div>\n      ":'\n        <div class="'+i+'">\n          <div class="picker-items">'+(r=e.values.map(function(t,a){return'\n        <div class="picker-item" data-picker-value="'+t+'">\n          <span>'+(e.displayValues?e.displayValues[a]:t)+"</span>\n        </div>\n      "}).join(""))+"</div>\n        </div>\n      ",t?r.trim():a.trim()},t.prototype.renderInline=function(){var e=this,t=e.params;return('\n      <div class="picker picker-inline '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n        '+(t.toolbar?e.renderToolbar():"")+'\n        <div class="picker-columns">\n          '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n          <div class="picker-center-highlight"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderSheet=function(){var e=this,t=e.params;return('\n      <div class="sheet-modal picker picker-sheet '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n        '+(t.toolbar?e.renderToolbar():"")+'\n        <div class="sheet-modal-inner picker-columns">\n          '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n          <div class="picker-center-highlight"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderPopover=function(){var e=this,t=e.params;return('\n      <div class="popover picker-popover">\n        <div class="popover-inner">\n          <div class="picker '+(t.rotateEffect?"picker-3d":"")+" "+(t.cssClass||"")+'">\n            '+(t.toolbar?e.renderToolbar():"")+'\n            <div class="picker-columns">\n              '+e.cols.map(function(t){return e.renderColumn(t)}).join("")+'\n              <div class="picker-center-highlight"></div>\n            </div>\n          </div>\n        </div>\n      </div>\n    ').trim()},t.prototype.render=function(){return this.params.render?this.params.render.call(this):this.inline?this.renderInline():this.isPopover()?this.renderPopover():this.renderSheet()},t.prototype.onOpen=function(){var e=this,t=e.initialized,a=e.$el,r=e.app,i=e.$inputEl,n=e.inline,s=e.value,o=e.params;e.opened=!0,e.closing=!1,e.opening=!0,e.attachResizeEvent(),a.find(".picker-column").each(function(a,r){var i=!0;(!t&&o.value||t&&s)&&(i=!1),e.initColumn(r,i)}),t?s&&e.setValue(s,0):s?e.setValue(s,0):o.value&&e.setValue(o.value,0),!n&&i&&i.length&&"md"===r.theme&&i.trigger("focus"),e.initialized=!0,a&&a.trigger("picker:open",e),i&&i.trigger("picker:open",e),e.emit("local::open pickerOpen",e)},t.prototype.onOpened=function(){this.opening=!1,this.$el&&this.$el.trigger("picker:opened",this),this.$inputEl&&this.$inputEl.trigger("picker:opened",this),this.emit("local::opened pickerOpened",this)},t.prototype.onClose=function(){var e=this.app;this.opening=!1,this.closing=!0,this.detachResizeEvent(),this.cols.forEach(function(e){e.destroy&&e.destroy()}),this.$inputEl&&"md"===e.theme&&this.$inputEl.trigger("blur"),this.$el&&this.$el.trigger("picker:close",this),this.$inputEl&&this.$inputEl.trigger("picker:close",this),this.emit("local::close pickerClose",this)},t.prototype.onClosed=function(){var e=this;e.opened=!1,e.closing=!1,e.inline||Utils.nextTick(function(){e.modal&&e.modal.el&&e.modal.destroy&&(e.params.routableModals||e.modal.destroy()),delete e.modal}),e.$el&&e.$el.trigger("picker:closed",e),e.$inputEl&&e.$inputEl.trigger("picker:closed",e),e.emit("local::closed pickerClosed",e)},t.prototype.open=function(){var e,t=this,a=t.app,r=t.opened,i=t.inline,n=t.$inputEl;if(!r){if(0===t.cols.length&&t.params.cols.length&&t.params.cols.forEach(function(e){t.cols.push(e)}),i)return t.$el=$(t.render()),t.$el[0].f7Picker=t,t.$containerEl.append(t.$el),t.onOpen(),void t.onOpened();var s=t.isPopover(),o=s?"popover":"sheet",l={targetEl:n,scrollToEl:t.params.scrollToInput?n:void 0,content:t.render(),backdrop:s,on:{open:function(){t.modal=this,t.$el=s?this.$el.find(".picker"):this.$el,t.$el[0].f7Picker=t,t.onOpen()},opened:function(){t.onOpened()},close:function(){t.onClose()},closed:function(){t.onClosed()}}};t.params.routableModals?t.view.router.navigate({url:t.url,route:(e={path:t.url},e[o]=l,e)}):(t.modal=a[o].create(l),t.modal.open())}},t.prototype.close=function(){var e=this.opened,t=this.inline;if(e)return t?(this.onClose(),void this.onClosed()):void(this.params.routableModals?this.view.router.back():this.modal.close())},t.prototype.init=function(){if(this.initInput(),this.inline)return this.open(),void this.emit("local::init pickerInit",this);!this.initialized&&this.params.value&&this.setValue(this.params.value),this.$inputEl&&this.attachInputEvents(),this.params.closeByOutsideClick&&this.attachHtmlEvents(),this.emit("local::init pickerInit",this)},t.prototype.destroy=function(){if(!this.destroyed){var e=this.$el;this.emit("local::beforeDestroy pickerBeforeDestroy",this),e&&e.trigger("picker:beforedestroy",this),this.close(),this.$inputEl&&this.detachInputEvents(),this.params.closeByOutsideClick&&this.detachHtmlEvents(),e&&e.length&&delete this.$el[0].f7Picker,Utils.deleteProps(this),this.destroyed=!0}},t}(Framework7Class),Picker$1={name:"picker",static:{Picker:Picker},create:function(){this.picker=ConstructorMethods({defaultSelector:".picker",constructor:Picker,app:this,domProp:"f7Picker"}),this.picker.close=function(e){void 0===e&&(e=".picker");var t=$(e);if(0!==t.length){var a=t[0].f7Picker;!a||a&&!a.opened||a.close()}}},params:{picker:{updateValuesOnMomentum:!1,updateValuesOnTouchmove:!0,updateValuesOnMousewheel:!0,mousewheel:!0,rotateEffect:!1,momentumRatio:7,freeMode:!1,cols:[],containerEl:null,openIn:"auto",formatValue:null,inputEl:null,inputReadOnly:!0,closeByOutsideClick:!0,scrollToInput:!0,toolbar:!0,toolbarCloseText:"Done",cssClass:null,routableModals:!0,view:null,url:"select/",renderToolbar:null,render:null}}},InfiniteScroll={handleScroll:function(e,t){var a,r=$(e),i=r[0].scrollTop,n=r[0].scrollHeight,s=r[0].offsetHeight,o=r[0].getAttribute("data-infinite-distance"),l=r.find(".virtual-list"),p=r.hasClass("infinite-scroll-top");if(o||(o=50),"string"==typeof o&&o.indexOf("%")>=0&&(o=parseInt(o,10)/100*s),o>s&&(o=s),p)i<o&&(r.trigger("infinite",t),this.emit("infinite",r[0],t));else if(i+s>=n-o){if(l.length>0&&(a=l.eq(-1)[0].f7VirtualList)&&!a.reachEnd&&!a.params.updatableScroll)return;r.trigger("infinite",t),this.emit("infinite",r[0],t)}},create:function(e){var t=$(e),a=this;function r(e){a.infiniteScroll.handle(this,e)}t.each(function(e,t){t.f7InfiniteScrollHandler=r,t.addEventListener("scroll",t.f7InfiniteScrollHandler)})},destroy:function(e){$(e).each(function(e,t){t.removeEventListener("scroll",t.f7InfiniteScrollHandler),delete t.f7InfiniteScrollHandler})}},InfiniteScroll$1={name:"infiniteScroll",create:function(){Utils.extend(this,{infiniteScroll:{handle:InfiniteScroll.handleScroll.bind(this),create:InfiniteScroll.create.bind(this),destroy:InfiniteScroll.destroy.bind(this)}})},on:{tabMounted:function(e){var t=this,a=$(e),r=a.find(".infinite-scroll-content");a.is(".infinite-scroll-content")&&r.add(a),r.each(function(e,a){t.infiniteScroll.create(a)})},tabBeforeRemove:function(e){var t=$(e),a=this,r=t.find(".infinite-scroll-content");t.is(".infinite-scroll-content")&&r.add(t),r.each(function(e,t){a.infiniteScroll.destroy(t)})},pageInit:function(e){var t=this;e.$el.find(".infinite-scroll-content").each(function(e,a){t.infiniteScroll.create(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".infinite-scroll-content").each(function(e,a){t.infiniteScroll.destroy(a)})}}},PullToRefresh=function(e){function t(t,a){e.call(this,{},[t]);var r=this,i=$(a),n=i.find(".ptr-preloader");r.$el=i,r.el=i[0],r.app=t,r.bottom=r.$el.hasClass("ptr-bottom"),r.useModulesParams({});var s,o,l,p="md"===t.theme,c="ios"===t.theme,d="aurora"===t.theme;r.done=function(){return(p?n:i).transitionEnd(function(){i.removeClass("ptr-transitioning ptr-pull-up ptr-pull-down"),i.trigger("ptr:done"),r.emit("local::done ptrDone",i[0])}),i.removeClass("ptr-refreshing").addClass("ptr-transitioning"),r},r.refresh=function(){return i.hasClass("ptr-refreshing")?r:(i.addClass("ptr-transitioning ptr-refreshing"),i.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",i[0],r.done),r)},r.mousewheel="true"===i.attr("data-ptr-mousewheel");var u,h,f,v,m,g,b,y,w,C,x,k,E,S={},T=!1,M=!1,P=!1,O=0,D=!1,I=i.parents(".page");function R(e){if(o){if("android"!==Device.os)return;if("targetTouches"in e&&e.targetTouches.length>1)return}i.hasClass("ptr-refreshing")||$(e.target).closest(".sortable-handler, .ptr-ignore, .card-expandable.card-opened").length||(l=!1,y=!1,o=!0,u=void 0,m=void 0,"touchstart"===e.type&&(s=e.targetTouches[0].identifier),S.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,S.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY)}function B(e){if(o){var t,c,d;if("touchmove"===e.type){if(s&&e.touches)for(var k=0;k<e.touches.length;k+=1)e.touches[k].identifier===s&&(d=e.touches[k]);d||(d=e.targetTouches[0]),t=d.pageX,c=d.pageY}else t=e.pageX,c=e.pageY;if(t&&c)if(void 0===u&&(u=!!(u||Math.abs(c-S.y)>Math.abs(t-S.x))),u){if(v=i[0].scrollTop,!l){var E;if(i.removeClass("ptr-transitioning"),w=i[0].scrollHeight,C=i[0].offsetHeight,r.bottom&&(x=w-C),v>w)return void(o=!1);var D=$(e.target).closest(".ptr-watch-scroll");if(D.length&&D.each(function(e,t){t!==a&&t.scrollHeight>t.offsetHeight&&"auto"===$(t).css("overflow")&&(!r.bottom&&t.scrollTop>0||r.bottom&&t.scrollTop<t.scrollHeight-t.offsetHeight)&&(E=!0)}),E)return void(o=!1);b&&(g=i.attr("data-ptr-distance")).indexOf("%")>=0&&(g=w*parseInt(g,10)/100),O=i.hasClass("ptr-refreshing")?g:0,M=!(w!==C&&"ios"===Device.os&&!p),P=!1}l=!0,h=c-S.y,void 0===m&&(r.bottom?v!==x:0!==v)&&(m=!0),(r.bottom?h<0&&v>=x||v>x:h>0&&v<=0||v<0)?("ios"===Device.os&&parseInt(Device.osVersion.split(".")[0],10)>7&&(r.bottom||0!==v||m||(M=!0),r.bottom&&v===x&&!m&&(M=!0)),M||!r.bottom||p||(i.css("-webkit-overflow-scrolling","auto"),i.scrollTop(x),P=!0),(M||P)&&(e.cancelable&&e.preventDefault(),f=(r.bottom?-1*Math.pow(Math.abs(h),.85):Math.pow(h,.85))+O,p?n.transform("translate3d(0,"+f+"px,0)").find(".ptr-arrow").transform("rotate("+(Math.abs(h)/66*180+100)+"deg)"):r.bottom?i.children().transform("translate3d(0,"+f+"px,0)"):i.transform("translate3d(0,"+f+"px,0)")),(M||P)&&Math.pow(Math.abs(h),.85)>g||!M&&Math.abs(h)>=2*g?(T=!0,i.addClass("ptr-pull-up").removeClass("ptr-pull-down")):(T=!1,i.removeClass("ptr-pull-up").addClass("ptr-pull-down")),y||(i.trigger("ptr:pullstart"),r.emit("local::pullStart ptrPullStart",i[0]),y=!0),i.trigger("ptr:pullmove",{event:e,scrollTop:v,translate:f,touchesDiff:h}),r.emit("local::pullMove ptrPullMove",i[0],{event:e,scrollTop:v,translate:f,touchesDiff:h})):(y=!1,i.removeClass("ptr-pull-up ptr-pull-down"),T=!1)}else o=!1}}function L(e){return"touchend"===e.type&&e.changedTouches&&e.changedTouches.length>0&&s&&e.changedTouches[0].identifier!==s?(o=!1,u=!1,l=!1,void(s=null)):o&&l?(f&&(i.addClass("ptr-transitioning"),f=0),p?n.transform("").find(".ptr-arrow").transform(""):r.bottom?i.children().transform(""):i.transform(""),M||!r.bottom||p||i.css("-webkit-overflow-scrolling",""),T?(i.addClass("ptr-refreshing"),i.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",i[0],r.done)):i.removeClass("ptr-pull-down"),o=!1,l=!1,void(y&&(i.trigger("ptr:pullend"),r.emit("local::pullEnd ptrPullEnd",i[0])))):(o=!1,void(l=!1))}(I.find(".navbar").length>0||I.parents(".view").children(".navbar").length>0)&&(D=!0),I.hasClass("no-navbar")&&(D=!1),D||r.bottom||i.addClass("ptr-no-navbar"),i.attr("data-ptr-distance")?b=!0:p?g=66:c?g=44:d&&(g=38);var A=!0,z=0;function H(){A=!0,E=!1,z=0,f&&(i.addClass("ptr-transitioning"),f=0),p?n.transform("").find(".ptr-arrow").transform(""):r.bottom?i.children().transform(""):i.transform(""),T?(i.addClass("ptr-refreshing"),i.trigger("ptr:refresh",r.done),r.emit("local::refresh ptrRefresh",i[0],r.done)):i.removeClass("ptr-pull-down"),y&&(i.trigger("ptr:pullend"),r.emit("local::pullEnd ptrPullEnd",i[0]))}function U(e){if(A){var t=e.deltaX,s=e.deltaY;if(!(Math.abs(t)>Math.abs(s)||i.hasClass("ptr-refreshing")||$(e.target).closest(".sortable-handler, .ptr-ignore, .card-expandable.card-opened").length)){if(clearTimeout(k),v=i[0].scrollTop,!E){var o;if(i.removeClass("ptr-transitioning"),w=i[0].scrollHeight,C=i[0].offsetHeight,r.bottom&&(x=w-C),v>w)return void(A=!1);var c=$(e.target).closest(".ptr-watch-scroll");if(c.length&&c.each(function(e,t){t!==a&&t.scrollHeight>t.offsetHeight&&"auto"===$(t).css("overflow")&&(!r.bottom&&t.scrollTop>0||r.bottom&&t.scrollTop<t.scrollHeight-t.offsetHeight)&&(o=!0)}),o)return void(A=!1);b&&(g=i.attr("data-ptr-distance")).indexOf("%")>=0&&(g=w*parseInt(g,10)/100)}l=!0,h=z-=s,void 0===m&&(r.bottom?v!==x:0!==v)&&(m=!0),(r.bottom?h<0&&v>=x||v>x:h>0&&v<=0||v<0)?(e.cancelable&&e.preventDefault(),f=h,Math.abs(f)>g&&(f=g+Math.pow(Math.abs(f)-g,.7),r.bottom&&(f=-f)),p?n.transform("translate3d(0,"+f+"px,0)").find(".ptr-arrow").transform("rotate("+(Math.abs(h)/66*180+100)+"deg)"):r.bottom?i.children().transform("translate3d(0,"+f+"px,0)"):i.transform("translate3d(0,"+f+"px,0)"),Math.abs(f)>g?(T=!0,i.addClass("ptr-pull-up").removeClass("ptr-pull-down")):(T=!1,i.removeClass("ptr-pull-up").addClass("ptr-pull-down")),y||(i.trigger("ptr:pullstart"),r.emit("local::pullStart ptrPullStart",i[0]),y=!0),i.trigger("ptr:pullmove",{event:e,scrollTop:v,translate:f,touchesDiff:h}),r.emit("local::pullMove ptrPullMove",i[0],{event:e,scrollTop:v,translate:f,touchesDiff:h})):(y=!1,i.removeClass("ptr-pull-up ptr-pull-down"),T=!1),k=setTimeout(H,300)}}}return I.length&&i.length?(i[0].f7PullToRefresh=r,r.attachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};i.on(t.touchEvents.start,R,e),t.on("touchmove:active",B),t.on("touchend:passive",L),r.mousewheel&&!r.bottom&&i.on("wheel",U)},r.detachEvents=function(){var e=!!Support.passiveListener&&{passive:!0};i.off(t.touchEvents.start,R,e),t.off("touchmove:active",B),t.off("touchend:passive",L),r.mousewheel&&!r.bottom&&i.off("wheel",U)},r.useModules(),r.init(),r):r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy ptrBeforeDestroy",e),e.$el.trigger("ptr:beforedestroy",e),delete e.el.f7PullToRefresh,e.detachEvents(),Utils.deleteProps(e),e=null},t}(Framework7Class),PullToRefresh$1={name:"pullToRefresh",create:function(){var e=this;e.ptr=Utils.extend(ConstructorMethods({defaultSelector:".ptr-content",constructor:PullToRefresh,app:e,domProp:"f7PullToRefresh"}),{done:function(t){var a=e.ptr.get(t);if(a)return a.done()},refresh:function(t){var a=e.ptr.get(t);if(a)return a.refresh()}})},static:{PullToRefresh:PullToRefresh},on:{tabMounted:function(e){var t=this,a=$(e),r=a.find(".ptr-content");a.is(".ptr-content")&&r.add(a),r.each(function(e,a){t.ptr.create(a)})},tabBeforeRemove:function(e){var t=$(e),a=this,r=t.find(".ptr-content");t.is(".ptr-content")&&r.add(t),r.each(function(e,t){a.ptr.destroy(t)})},pageInit:function(e){var t=this;e.$el.find(".ptr-content").each(function(e,a){t.ptr.create(a)})},pageBeforeRemove:function(e){var t=this;e.$el.find(".ptr-content").each(function(e,a){t.ptr.destroy(a)})}}},Lazy={destroy:function(e){var t=$(e).closest(".page");t.length&&t[0].f7LazyDestroy&&t[0].f7LazyDestroy()},create:function(e){var t=this,a=$(e).closest(".page").eq(0),r=a.find(".lazy");if(0!==r.length||a.hasClass("lazy")){var i=t.params.lazy.placeholder;!1!==i&&r.each(function(e,t){$(t).attr("data-src")&&!$(t).attr("src")&&$(t).attr("src",i)});var n=[],s=!1;if(t.params.lazy.observer&&Support.intersectionObserver){var o=a[0].f7LazyObserver;return o||(o=new win.IntersectionObserver(function(e,a){e.forEach(function(e){if(e.isIntersecting){if(t.params.lazy.sequential&&s)return void(n.indexOf(e.target)<0&&n.push(e.target));s=!0,t.lazy.loadImage(e.target,l),a.unobserve(e.target)}})},{root:a[0]})),r.each(function(e,t){t.f7LazyObserverAdded||(t.f7LazyObserverAdded=!0,o.observe(t))}),void(a[0].f7LazyDestroy||(a[0].f7LazyDestroy=function(){o.disconnect(),delete a[0].f7LazyDestroy,delete a[0].f7LazyObserver}))}a[0].f7LazyDestroy||(a[0].f7LazyDestroy=function(){a[0].f7LazyAttached=!1,delete a[0].f7LazyAttached,a.off("lazy",p),a.off("scroll",p,!0),a.find(".tab").off("tab:mounted tab:show",p),t.off("resize",p)}),a[0].f7LazyAttached||(a[0].f7LazyAttached=!0,a.on("lazy",p),a.on("scroll",p,!0),a.find(".tab").on("tab:mounted tab:show",p),t.on("resize",p)),p()}function l(e){n.indexOf(e)>=0&&n.splice(n.indexOf(e),1),s=!1,t.params.lazy.sequential&&n.length>0&&(s=!0,t.lazy.loadImage(n[0],l))}function p(){t.lazy.load(a,function(e){t.params.lazy.sequential&&s?n.indexOf(e)<0&&n.push(e):(s=!0,t.lazy.loadImage(e,l))})}},isInViewport:function(e){var t=e.getBoundingClientRect(),a=this.params.lazy.threshold||0;return t.top>=0-a&&t.left>=0-a&&t.top<=this.height+a&&t.left<=this.width+a},loadImage:function(e,t){var a=this,r=$(e),i=r.attr("data-background"),n=i||r.attr("data-src");if(n){var s=new win.Image;s.onload=function(){r.removeClass("lazy").addClass("lazy-loaded"),i?r.css("background-image","url("+n+")"):r.attr("src",n),t&&t(e),r.trigger("lazy:loaded"),a.emit("lazyLoaded",r[0])},s.onerror=function(){r.removeClass("lazy").addClass("lazy-loaded"),i?r.css("background-image","url("+(a.params.lazy.placeholder||"")+")"):r.attr("src",a.params.lazy.placeholder||""),t&&t(e),r.trigger("lazy:error"),a.emit("lazyError",r[0])},s.src=n,r.removeAttr("data-src").removeAttr("data-background"),r.trigger("lazy:load"),a.emit("lazyLoad",r[0])}},load:function(e,t){var a=this,r=$(e);r.hasClass("page")||(r=r.parents(".page").eq(0)),0!==r.length&&r.find(".lazy").each(function(e,r){$(r).parents(".tab:not(.tab-active)").length>0||a.lazy.isInViewport(r)&&(t?t(r):a.lazy.loadImage(r))})}},Lazy$1={name:"lazy",params:{lazy:{placeholder:"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAA1BMVEXCwsK592mkAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==",threshold:0,sequential:!0,observer:!0}},create:function(){Utils.extend(this,{lazy:{create:Lazy.create.bind(this),destroy:Lazy.destroy.bind(this),loadImage:Lazy.loadImage.bind(this),load:Lazy.load.bind(this),isInViewport:Lazy.isInViewport.bind(this)}})},on:{pageInit:function(e){(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.create(e.$el)},pageAfterIn:function(e){this.params.lazy.observer&&Support.intersectionObserver||(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.create(e.$el)},pageBeforeRemove:function(e){(e.$el.find(".lazy").length>0||e.$el.hasClass("lazy"))&&this.lazy.destroy(e.$el)},tabMounted:function(e){var t=$(e);(t.find(".lazy").length>0||t.hasClass("lazy"))&&this.lazy.create(t)},tabBeforeRemove:function(e){if(!this.params.lazy.observer||!Support.intersectionObserver){var t=$(e);(t.find(".lazy").length>0||t.hasClass("lazy"))&&this.lazy.destroy(t)}}}},DataTable=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i={};r.useModulesParams(i),r.params=Utils.extend(i,a);var n=$(r.params.el);if(0!==n.length){if(r.$el=n,r.el=n[0],r.$el[0].f7DataTable){var s=r.$el[0].f7DataTable;return r.destroy(),s}return r.$el[0].f7DataTable=r,Utils.extend(r,{collapsible:n.hasClass("data-table-collapsible"),$headerEl:n.find(".data-table-header"),$headerSelectedEl:n.find(".data-table-header-selected")}),r.attachEvents=function(){r.$el.on("change",'.checkbox-cell input[type="checkbox"]',o),r.$el.find("thead .sortable-cell").on("click",l)},r.detachEvents=function(){r.$el.off("change",'.checkbox-cell input[type="checkbox"]',o),r.$el.find("thead .sortable-cell").off("click",l)},r.useModules(),r.init(),r}function o(e){if(!e.detail||!e.detail.sentByF7DataTable){var t=$(this),a=t[0].checked,i=t.parents("td,th").index();if(t.parents("thead").length>0)0===i&&n.find("tbody tr")[a?"addClass":"removeClass"]("data-table-row-selected"),n.find("tbody tr td:nth-child("+(i+1)+") input").prop("checked",a).trigger("change",{sentByF7DataTable:!0}),t.prop("indeterminate",!1);else{0===i&&t.parents("tr")[a?"addClass":"removeClass"]("data-table-row-selected");var s=n.find("tbody .checkbox-cell:nth-child("+(i+1)+') input[type="checkbox"]:checked').length,o=n.find("tbody tr").length,l=n.find("thead .checkbox-cell:nth-child("+(i+1)+') input[type="checkbox"]');a?s===o&&l.prop("checked",!0).trigger("change",{sentByF7DataTable:!0}):l.prop("checked",!1),l.prop("indeterminate",s>0&&s<o)}r.checkSelectedHeader()}}function l(){var e,t=$(this),a=t.hasClass("sortable-cell-active"),i=t.hasClass("sortable-desc")?"desc":"asc";a?(e="desc"===i?"asc":"desc",t.removeClass("sortable-desc sortable-asc").addClass("sortable-"+e)):(n.find("thead .sortable-cell-active").removeClass("sortable-cell-active"),t.addClass("sortable-cell-active"),e=i),t.trigger("datatable:sort",e),r.emit("local::sort dataTableSort",r,e)}}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.setCollapsibleLabels=function(){var e=this;e.collapsible&&e.$el.find("tbody td:not(.checkbox-cell)").each(function(t,a){var r=$(a),i=r.index(),n=r.attr("data-collapsible-title");n||""===n||r.attr("data-collapsible-title",e.$el.find("thead th").eq(i).text())})},t.prototype.checkSelectedHeader=function(){if(this.$headerEl.length>0&&this.$headerSelectedEl.length>0){var e=this.$el.find("tbody .checkbox-cell input:checked").length;this.$el[e>0?"addClass":"removeClass"]("data-table-has-checked"),this.$headerSelectedEl.find(".data-table-selected-count").text(e)}},t.prototype.init=function(){this.attachEvents(),this.setCollapsibleLabels(),this.checkSelectedHeader()},t.prototype.destroy=function(){var e=this;e.$el.trigger("datatable:beforedestroy",e),e.emit("local::beforeDestroy dataTableBeforeDestroy",e),e.attachEvents(),e.$el[0]&&(e.$el[0].f7DataTable=null,delete e.$el[0].f7DataTable),Utils.deleteProps(e),e=null},t}(Framework7Class),DataTable$1={name:"dataTable",static:{DataTable:DataTable},create:function(){this.dataTable=ConstructorMethods({defaultSelector:".data-table",constructor:DataTable,app:this,domProp:"f7DataTable"})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".data-table-init").each(function(e,a){t.dataTable.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".data-table-init").each(function(e,a){t.dataTable.create({el:a})})},pageBeforeRemove:function(e){var t=this;e.$el.find(".data-table-init").each(function(e,a){t.dataTable.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".data-table-init").each(function(e,a){t.dataTable.create({el:a})})}},vnode:{"data-table-init":{insert:function(e){var t=e.elm;this.dataTable.create({el:t})},destroy:function(e){var t=e.elm;this.dataTable.destroy(t)}}}},Fab={morphOpen:function(e,t){var a=this,r=$(e),i=$(t);if(0!==i.length){i.transition(0).addClass("fab-morph-target-visible");var n={width:i[0].offsetWidth,height:i[0].offsetHeight,offset:i.offset(),borderRadius:i.css("border-radius"),zIndex:i.css("z-index")},s={width:r[0].offsetWidth,height:r[0].offsetHeight,offset:r.offset(),translateX:Utils.getTranslate(r[0],"x"),translateY:Utils.getTranslate(r[0],"y")};r[0].f7FabMorphData={$targetEl:i,target:n,fab:s};var o=s.offset.left+s.width/2-(n.offset.left+n.width/2)-s.translateX,l=s.offset.top+s.height/2-(n.offset.top+n.height/2)-s.translateY,p=n.width/s.width,c=n.height/s.height,d=Math.ceil(parseInt(n.borderRadius,10)/Math.max(p,c));d>0&&(d+=2),r[0].f7FabMorphResizeHandler=function(){r.transition(0).transform(""),i.transition(0),n.width=i[0].offsetWidth,n.height=i[0].offsetHeight,n.offset=i.offset(),s.offset=r.offset();var e=s.offset.left+s.width/2-(n.offset.left+n.width/2)-s.translateX,t=s.offset.top+s.height/2-(n.offset.top+n.height/2)-s.translateY,a=n.width/s.width,o=n.height/s.height;r.transform("translate3d("+-e+"px, "+-t+"px, 0) scale("+a+", "+o+")")},i.css("opacity",0).transform("scale("+1/p+", "+1/c+")"),r.addClass("fab-opened").css("z-index",n.zIndex-1).transform("translate3d("+-o+"px, "+-l+"px, 0)"),r.transitionEnd(function(){i.transition(""),Utils.nextFrame(function(){i.css("opacity",1).transform("scale(1,1)"),r.transform("translate3d("+-o+"px, "+-l+"px, 0) scale("+p+", "+c+")").css("border-radius",d+"px").css("box-shadow","none")}),a.on("resize",r[0].f7FabMorphResizeHandler),i.parents(".page-content").length>0&&i.parents(".page-content").on("scroll",r[0].f7FabMorphResizeHandler)})}},morphClose:function(e){var t=$(e),a=t[0].f7FabMorphData;if(a){var r=a.$targetEl,i=a.target,n=a.fab;if(0!==r.length){var s=n.offset.left+n.width/2-(i.offset.left+i.width/2)-n.translateX,o=n.offset.top+n.height/2-(i.offset.top+i.height/2)-n.translateY,l=i.width/n.width,p=i.height/n.height;this.off("resize",t[0].f7FabMorphResizeHandler),r.parents(".page-content").length>0&&r.parents(".page-content").off("scroll",t[0].f7FabMorphResizeHandler),r.css("opacity",0).transform("scale("+1/l+", "+1/p+")"),t.transition("").css("box-shadow","").css("border-radius","").transform("translate3d("+-s+"px, "+-o+"px, 0)"),t.transitionEnd(function(){t.css("z-index","").removeClass("fab-opened").transform(""),Utils.nextFrame(function(){t.transitionEnd(function(){r.removeClass("fab-morph-target-visible").css("opacity","").transform("").transition("")})})})}}},open:function(e,t){var a=$(e).eq(0),r=a.find(".fab-buttons");if(a.length&&!a.hasClass("fab-opened")&&(r.length||a.hasClass("fab-morph"))){if(this.fab.openedEl){if(this.fab.openedEl===a[0])return;this.fab.close(this.fab.openedEl)}this.fab.openedEl=a[0],a.hasClass("fab-morph")?this.fab.morphOpen(a,t||a.attr("data-morph-to")):a.addClass("fab-opened"),a.trigger("fab:open")}},close:function(e){void 0===e&&(e=".fab-opened");var t=$(e).eq(0),a=t.find(".fab-buttons");t.length&&t.hasClass("fab-opened")&&(a.length||t.hasClass("fab-morph"))&&(this.fab.openedEl=null,t.hasClass("fab-morph")?this.fab.morphClose(t):t.removeClass("fab-opened"),t.trigger("fab:close"))},toggle:function(e){$(e).hasClass("fab-opened")?this.fab.close(e):this.fab.open(e)}},Fab$1={name:"fab",create:function(){Utils.extend(this,{fab:{openedEl:null,morphOpen:Fab.morphOpen.bind(this),morphClose:Fab.morphClose.bind(this),open:Fab.open.bind(this),close:Fab.close.bind(this),toggle:Fab.toggle.bind(this)}})},clicks:{".fab > a":function(e){this.fab.toggle(e.parents(".fab"))},".fab-open":function(e,t){void 0===t&&(t={});this.fab.open(t.fab)},".fab-close":function(e,t){void 0===t&&(t={});this.fab.close(t.fab)}}},Searchbar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i={el:void 0,inputEl:void 0,inputEvents:"change input compositionend",disableButton:!0,disableButtonEl:void 0,backdropEl:void 0,searchContainer:void 0,searchItem:"li",searchIn:void 0,searchGroup:".list-group",searchGroupTitle:".item-divider, .list-group-title",ignore:".searchbar-ignore",foundEl:".searchbar-found",notFoundEl:".searchbar-not-found",hideOnEnableEl:".searchbar-hide-on-enable",hideOnSearchEl:".searchbar-hide-on-search",backdrop:void 0,removeDiacritics:!0,customSearch:!1,hideDividers:!0,hideGroups:!0,disableOnBackdropClick:!0,expandable:!1,inline:!1};r.useModulesParams(i),r.params=Utils.extend(i,a);var n,s=$(r.params.el);if(0===s.length)return r;if(s[0].f7Searchbar)return s[0].f7Searchbar;s[0].f7Searchbar=r;var o,l,p,c,d=s.parents(".navbar-inner");if(s.parents(".page").length>0)n=s.parents(".page");else if(d.length>0&&!(n=$(t.navbar.getPageByEl(d[0]))).length){var u=s.parents(".view").find(".page-current");u[0]&&u[0].f7Page&&u[0].f7Page.navbarEl===d[0]&&(n=u)}a.foundEl?o=$(a.foundEl):"string"==typeof r.params.foundEl&&n&&(o=n.find(r.params.foundEl)),a.notFoundEl?l=$(a.notFoundEl):"string"==typeof r.params.notFoundEl&&n&&(l=n.find(r.params.notFoundEl)),a.hideOnEnableEl?p=$(a.hideOnEnableEl):"string"==typeof r.params.hideOnEnableEl&&n&&(p=n.find(r.params.hideOnEnableEl)),a.hideOnSearchEl?c=$(a.hideOnSearchEl):"string"==typeof r.params.hideOnSearchEl&&n&&(c=n.find(r.params.hideOnSearchEl));var h,f,v,m,g=r.params.expandable||s.hasClass("searchbar-expandable"),b=r.params.inline||s.hasClass("searchbar-inline");function y(e){e.preventDefault()}function w(e){r.enable(e),r.$el.addClass("searchbar-focused")}function C(){r.$el.removeClass("searchbar-focused"),"aurora"!==t.theme||m&&m.length&&r.params.disableButton||r.query||r.disable()}function x(){var e=r.$inputEl.val().trim();(r.$searchContainer&&r.$searchContainer.length>0&&(r.params.searchIn||r.isVirtualList||r.params.searchIn===r.params.searchItem)||r.params.customSearch)&&r.search(e,!0)}function k(e,t){r.$el.trigger("searchbar:clear",t),r.emit("local::clear searchbarClear",r,t)}function E(e){r.disable(e)}function S(){!r||r&&!r.$el||r.enabled&&(r.$el.removeClass("searchbar-enabled"),r.expandable&&r.$el.parents(".navbar-inner").removeClass("with-searchbar-expandable-enabled"))}function T(){!r||r&&!r.$el||r.enabled&&(r.$el.addClass("searchbar-enabled"),r.expandable&&r.$el.parents(".navbar-inner").addClass("with-searchbar-expandable-enabled"))}return void 0===r.params.backdrop&&(r.params.backdrop=!b&&"aurora"!==t.theme),r.params.backdrop&&0===(h=r.params.backdropEl?$(r.params.backdropEl):n&&n.length>0?n.find(".searchbar-backdrop"):s.siblings(".searchbar-backdrop")).length&&(h=$('<div class="searchbar-backdrop"></div>'),n&&n.length?s.parents(n).length>0&&d&&0===s.parents(d).length?h.insertBefore(s):h.insertBefore(n.find(".page-content").eq(0)):h.insertBefore(s)),r.params.searchContainer&&(f=$(r.params.searchContainer)),v=r.params.inputEl?$(r.params.inputEl):s.find('input[type="search"]').eq(0),r.params.disableButton&&(m=r.params.disableButtonEl?$(r.params.disableButtonEl):s.find(".searchbar-disable-button")),Utils.extend(r,{app:t,view:t.views.get(s.parents(".view")),$el:s,el:s[0],$backdropEl:h,backdropEl:h&&h[0],$searchContainer:f,searchContainer:f&&f[0],$inputEl:v,inputEl:v[0],$disableButtonEl:m,disableButtonEl:m&&m[0],disableButtonHasMargin:!1,$pageEl:n,pageEl:n&&n[0],$navbarEl:d,navbarEl:d&&d[0],$foundEl:o,foundEl:o&&o[0],$notFoundEl:l,notFoundEl:l&&l[0],$hideOnEnableEl:p,hideOnEnableEl:p&&p[0],$hideOnSearchEl:c,hideOnSearchEl:c&&c[0],previousQuery:"",query:"",isVirtualList:f&&f.hasClass("virtual-list"),virtualList:void 0,enabled:!1,expandable:g,inline:b}),r.attachEvents=function(){s.on("submit",y),r.params.disableButton&&r.$disableButtonEl.on("click",E),r.params.disableOnBackdropClick&&r.$backdropEl&&r.$backdropEl.on("click",E),r.expandable&&"ios"===t.theme&&r.view&&d.length&&r.$pageEl&&(r.$pageEl.on("page:beforeout",S),r.$pageEl.on("page:beforein",T)),r.$inputEl.on("focus",w),r.$inputEl.on("blur",C),r.$inputEl.on(r.params.inputEvents,x),r.$inputEl.on("input:clear",k)},r.detachEvents=function(){s.off("submit",y),r.params.disableButton&&r.$disableButtonEl.off("click",E),r.params.disableOnBackdropClick&&r.$backdropEl&&r.$backdropEl.off("click",E),r.expandable&&"ios"===t.theme&&r.view&&d.length&&r.$pageEl&&(r.$pageEl.off("page:beforeout",S),r.$pageEl.off("page:beforein",T)),r.$inputEl.off("focus",w),r.$inputEl.off("blur",C),r.$inputEl.off(r.params.inputEvents,x),r.$inputEl.off("input:clear",k)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.clear=function(e){var t=this;if(!t.query&&e&&$(e.target).hasClass("searchbar-clear"))return t.disable(),t;var a=t.value;return t.$inputEl.val("").trigger("change").focus(),t.$el.trigger("searchbar:clear",a),t.emit("local::clear searchbarClear",t,a),t},t.prototype.setDisableButtonMargin=function(){var e=this;if(!e.expandable){var t=e.app;e.$disableButtonEl.transition(0).show(),e.$disableButtonEl.css("margin-"+(t.rtl?"left":"right"),-e.disableButtonEl.offsetWidth+"px"),e._clientLeft=e.$disableButtonEl[0].clientLeft,e.$disableButtonEl.transition(""),e.disableButtonHasMargin=!0}},t.prototype.enable=function(e){var t=this;if(t.enabled)return t;var a=t.app;function r(){t.$backdropEl&&(t.$searchContainer&&t.$searchContainer.length||t.params.customSearch)&&!t.$el.hasClass("searchbar-enabled")&&!t.query&&t.backdropShow(),t.$el.addClass("searchbar-enabled"),(!t.$disableButtonEl||t.$disableButtonEl&&0===t.$disableButtonEl.length)&&t.$el.addClass("searchbar-enabled-no-disable-button"),!t.expandable&&t.$disableButtonEl&&t.$disableButtonEl.length>0&&"md"!==a.theme&&(t.disableButtonHasMargin||t.setDisableButtonMargin(),t.$disableButtonEl.css("margin-"+(a.rtl?"left":"right"),"0px")),t.expandable&&(t.$el.parents(".navbar-inner").hasClass("navbar-inner-large")&&t.$pageEl&&t.$pageEl.find(".page-content").addClass("with-searchbar-expandable-enabled"),"md"===a.theme&&t.$el.parent(".navbar-inner").parent(".navbar").length?t.$el.parent(".navbar-inner").parent(".navbar").addClass("with-searchbar-expandable-enabled"):(t.$el.parent(".navbar-inner").addClass("with-searchbar-expandable-enabled"),t.$el.parent(".navbar-inner-large").addClass("navbar-inner-large-collapsed"))),t.$hideOnEnableEl&&t.$hideOnEnableEl.addClass("hidden-by-searchbar"),t.$el.trigger("searchbar:enable"),t.emit("local::enable searchbarEnable",t)}t.enabled=!0;var i=!1;return!0===e&&doc.activeElement!==t.inputEl&&(i=!0),a.device.ios&&"ios"===a.theme?t.expandable?(i&&t.$inputEl.focus(),r()):(i&&t.$inputEl.focus(),!e||"focus"!==e.type&&!0!==e?r():Utils.nextTick(function(){r()},400)):(i&&t.$inputEl.focus(),"md"===a.theme&&t.expandable&&t.$el.parents(".page, .view, .navbar-inner").scrollLeft(a.rtl?100:0),r()),t},t.prototype.disable=function(){var e=this;if(!e.enabled)return e;var t=e.app;return e.$inputEl.val("").trigger("change"),e.$el.removeClass("searchbar-enabled searchbar-focused searchbar-enabled-no-disable-button"),e.expandable&&(e.$el.parents(".navbar-inner").hasClass("navbar-inner-large")&&e.$pageEl&&e.$pageEl.find(".page-content").removeClass("with-searchbar-expandable-enabled"),"md"===t.theme&&e.$el.parent(".navbar-inner").parent(".navbar").length?e.$el.parent(".navbar-inner").parent(".navbar").removeClass("with-searchbar-expandable-enabled"):(e.$el.parent(".navbar-inner").removeClass("with-searchbar-expandable-enabled"),e.$pageEl&&e.$pageEl.find(".page-content").trigger("scroll"))),!e.expandable&&e.$disableButtonEl&&e.$disableButtonEl.length>0&&"md"!==t.theme&&e.$disableButtonEl.css("margin-"+(t.rtl?"left":"right"),-e.disableButtonEl.offsetWidth+"px"),e.$backdropEl&&(e.$searchContainer&&e.$searchContainer.length||e.params.customSearch)&&e.backdropHide(),e.enabled=!1,e.$inputEl.blur(),e.$hideOnEnableEl&&e.$hideOnEnableEl.removeClass("hidden-by-searchbar"),e.$el.trigger("searchbar:disable"),e.emit("local::disable searchbarDisable",e),e},t.prototype.toggle=function(){return this.enabled?this.disable():this.enable(!0),this},t.prototype.backdropShow=function(){return this.$backdropEl&&this.$backdropEl.addClass("searchbar-backdrop-in"),this},t.prototype.backdropHide=function(){return this.$backdropEl&&this.$backdropEl.removeClass("searchbar-backdrop-in"),this},t.prototype.search=function(e,t){var a=this;if(a.previousQuery=a.query||"",e===a.previousQuery)return a;t||(a.enabled||a.enable(),a.$inputEl.val(e),a.$inputEl.trigger("input")),a.query=e,a.value=e;var r=a.$searchContainer,i=a.$el,n=a.$foundEl,s=a.$notFoundEl,o=a.$hideOnSearchEl,l=a.isVirtualList;if(e.length>0&&o?o.addClass("hidden-by-searchbar"):o&&o.removeClass("hidden-by-searchbar"),(r&&r.length&&i.hasClass("searchbar-enabled")||a.params.customSearch&&i.hasClass("searchbar-enabled"))&&(0===e.length?a.backdropShow():a.backdropHide()),a.params.customSearch)return i.trigger("searchbar:search",e,a.previousQuery),a.emit("local::search searchbarSearch",a,e,a.previousQuery),a;var p,c=[];if(l){if(a.virtualList=r[0].f7VirtualList,""===e.trim())return a.virtualList.resetFilter(),s&&s.hide(),n&&n.show(),i.trigger("searchbar:search",e,a.previousQuery),a.emit("local::search searchbarSearch",a,e,a.previousQuery),a;if(p=a.params.removeDiacritics?Utils.removeDiacritics(e):e,a.virtualList.params.searchAll)c=a.virtualList.params.searchAll(p,a.virtualList.items)||[];else if(a.virtualList.params.searchByItem)for(var d=0;d<a.virtualList.items.length;d+=1)a.virtualList.params.searchByItem(p,a.virtualList.params.items[d],d)&&c.push(d)}else{var u;u=a.params.removeDiacritics?Utils.removeDiacritics(e.trim().toLowerCase()).split(" "):e.trim().toLowerCase().split(" "),r.find(a.params.searchItem).removeClass("hidden-by-searchbar").each(function(e,t){var r=$(t),i=[],n=a.params.searchIn?r.find(a.params.searchIn):r;a.params.searchIn===a.params.searchItem&&(n=r),n.each(function(e,t){var r=$(t).text().trim().toLowerCase();a.params.removeDiacritics&&(r=Utils.removeDiacritics(r)),i.push(r)}),i=i.join(" ");for(var s=0,o=0;o<u.length;o+=1)i.indexOf(u[o])>=0&&(s+=1);s===u.length||a.params.ignore&&r.is(a.params.ignore)?c.push(r[0]):r.addClass("hidden-by-searchbar")}),a.params.hideDividers&&r.find(a.params.searchGroupTitle).each(function(e,t){for(var r=$(t),i=r.nextAll(a.params.searchItem),n=!0,s=0;s<i.length;s+=1){var o=i.eq(s);if(o.is(a.params.searchGroupTitle))break;o.hasClass("hidden-by-searchbar")||(n=!1)}var l=a.params.ignore&&r.is(a.params.ignore);n&&!l?r.addClass("hidden-by-searchbar"):r.removeClass("hidden-by-searchbar")}),a.params.hideGroups&&r.find(a.params.searchGroup).each(function(e,t){var r=$(t),i=a.params.ignore&&r.is(a.params.ignore);0!==r.find(a.params.searchItem).filter(function(e,t){return!$(t).hasClass("hidden-by-searchbar")}).length||i?r.removeClass("hidden-by-searchbar"):r.addClass("hidden-by-searchbar")})}return 0===c.length?(s&&s.show(),n&&n.hide()):(s&&s.hide(),n&&n.show()),l&&a.virtualList&&a.virtualList.filterItems(c),i.trigger("searchbar:search",e,a.previousQuery,c),a.emit("local::search searchbarSearch",a,e,a.previousQuery,c),a},t.prototype.init=function(){var e=this;e.expandable&&e.$el&&e.$el.addClass("searchbar-expandable"),e.inline&&e.$el&&e.$el.addClass("searchbar-inline"),e.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy searchbarBeforeDestroy",e),e.$el.trigger("searchbar:beforedestroy",e),e.detachEvents(),e.$el[0]&&(e.$el[0].f7Searchbar=null,delete e.$el[0].f7Searchbar),Utils.deleteProps(e)},t}(Framework7Class),Searchbar$1={name:"searchbar",static:{Searchbar:Searchbar},create:function(){this.searchbar=ConstructorMethods({defaultSelector:".searchbar",constructor:Searchbar,app:this,domProp:"f7Searchbar",addMethods:"clear enable disable toggle search".split(" ")})},on:{tabMounted:function(e){var t=this;$(e).find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))})},tabBeforeRemove:function(e){$(e).find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()})},pageInit:function(e){var t=this;e.$el.find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))}),"ios"===t.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".searchbar-init").each(function(e,a){var r=$(a);t.searchbar.create(Utils.extend(r.dataset(),{el:a}))})},pageBeforeRemove:function(e){e.$el.find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()}),"ios"===this.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".searchbar-init").each(function(e,t){t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()})}},clicks:{".searchbar-clear":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.clear()},".searchbar-enable":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.enable(!0)},".searchbar-disable":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.disable()},".searchbar-toggle":function(e,t){void 0===t&&(t={});var a=this.searchbar.get(t.searchbar);a&&a.toggle()}},vnode:{"searchbar-init":{insert:function(e){var t=e.elm,a=$(t);this.searchbar.create(Utils.extend(a.dataset(),{el:t}))},destroy:function(e){var t=e.elm;t.f7Searchbar&&t.f7Searchbar.destroy&&t.f7Searchbar.destroy()}}}},Messages=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i={autoLayout:!0,messages:[],newMessagesFirst:!1,scrollMessages:!0,scrollMessagesOnEdge:!0,firstMessageRule:void 0,lastMessageRule:void 0,tailMessageRule:void 0,sameNameMessageRule:void 0,sameHeaderMessageRule:void 0,sameFooterMessageRule:void 0,sameAvatarMessageRule:void 0,customClassMessageRule:void 0,renderMessage:void 0};r.useModulesParams(i),r.params=Utils.extend(i,a);var n=$(a.el).eq(0);if(0===n.length)return r;if(n[0].f7Messages)return n[0].f7Messages;n[0].f7Messages=r;var s=n.closest(".page-content").eq(0);return Utils.extend(r,{messages:r.params.messages,$el:n,el:n[0],$pageContentEl:s,pageContentEl:s[0]}),r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.getMessageData=function(e){var t=$(e),a={name:t.find(".message-name").html(),header:t.find(".message-header").html(),textHeader:t.find(".message-text-header").html(),textFooter:t.find(".message-text-footer").html(),footer:t.find(".message-footer").html(),isTitle:t.hasClass("messages-title"),type:t.hasClass("message-sent")?"sent":"received",text:t.find(".message-text").html(),image:t.find(".message-image").html(),imageSrc:t.find(".message-image img").attr("src"),typing:t.hasClass("message-typing")};a.isTitle&&(a.text=t.html()),a.text&&a.textHeader&&(a.text=a.text.replace('<div class="message-text-header">'+a.textHeader+"</div>","")),a.text&&a.textFooter&&(a.text=a.text.replace('<div class="message-text-footer">'+a.textFooter+"</div>",""));var r=t.find(".message-avatar").css("background-image");return"none"!==r&&""!==r||(r=void 0),r=r&&"string"==typeof r?r.replace("url(","").replace(")","").replace(/"/g,"").replace(/'/g,""):void 0,a.avatar=r,a},t.prototype.getMessagesData=function(){var e=this,t=[];return e.$el.find(".message, .messages-title").each(function(a,r){t.push(e.getMessageData(r))}),t},t.prototype.renderMessage=function(e){var t=this,a=Utils.extend({type:"sent",attrs:{}},e);if(t.params.renderMessage)return t.params.renderMessage.call(t,a);if(a.isTitle)return'<div class="messages-title">'+a.text+"</div>";var r=Object.keys(a.attrs).map(function(e){return e+'="'+a.attrs[e]+'"'}).join(" ");return'\n      <div class="message message-'+a.type+" "+(a.isTyping?"message-typing":"")+" "+(a.cssClass||"")+'" '+r+">\n        "+(a.avatar?'\n        <div class="message-avatar" style="background-image:url('+a.avatar+')"></div>\n        ':"")+'\n        <div class="message-content">\n          '+(a.name?'<div class="message-name">'+a.name+"</div>":"")+"\n          "+(a.header?'<div class="message-header">'+a.header+"</div>":"")+'\n          <div class="message-bubble">\n            '+(a.textHeader?'<div class="message-text-header">'+a.textHeader+"</div>":"")+"\n            "+(a.image?'<div class="message-image">'+a.image+"</div>":"")+"\n            "+(a.imageSrc&&!a.image?'<div class="message-image"><img src="'+a.imageSrc+'"></div>':"")+"\n            "+(a.text||a.isTyping?'<div class="message-text">'+(a.text||"")+(a.isTyping?'<div class="message-typing-indicator"><div></div><div></div><div></div></div>':"")+"</div>":"")+"\n            "+(a.textFooter?'<div class="message-text-footer">'+a.textFooter+"</div>":"")+"\n          </div>\n          "+(a.footer?'<div class="message-footer">'+a.footer+"</div>":"")+"\n        </div>\n      </div>\n    "},t.prototype.renderMessages=function(e,t){void 0===e&&(e=this.messages),void 0===t&&(t=this.params.newMessagesFirst?"prepend":"append");var a=this,r=e.map(function(e){return a.renderMessage(e)}).join("");a.$el[t](r)},t.prototype.isFirstMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.firstMessageRule&&(e=this.params).firstMessageRule.apply(e,t)},t.prototype.isLastMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.lastMessageRule&&(e=this.params).lastMessageRule.apply(e,t)},t.prototype.isTailMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.tailMessageRule&&(e=this.params).tailMessageRule.apply(e,t)},t.prototype.isSameNameMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameNameMessageRule&&(e=this.params).sameNameMessageRule.apply(e,t)},t.prototype.isSameHeaderMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameHeaderMessageRule&&(e=this.params).sameHeaderMessageRule.apply(e,t)},t.prototype.isSameFooterMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameFooterMessageRule&&(e=this.params).sameFooterMessageRule.apply(e,t)},t.prototype.isSameAvatarMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];return!!this.params.sameAvatarMessageRule&&(e=this.params).sameAvatarMessageRule.apply(e,t)},t.prototype.isCustomClassMessage=function(){for(var e,t=[],a=arguments.length;a--;)t[a]=arguments[a];if(this.params.customClassMessageRule)return(e=this.params).customClassMessageRule.apply(e,t)},t.prototype.layout=function(){var e=this;e.$el.find(".message, .messages-title").each(function(t,a){var r=$(a);e.messages||(e.messages=e.getMessagesData());var i=[],n=e.messages[t],s=e.messages[t-1],o=e.messages[t+1];e.isFirstMessage(n,s,o)&&i.push("message-first"),e.isLastMessage(n,s,o)&&i.push("message-last"),e.isTailMessage(n,s,o)&&i.push("message-tail"),e.isSameNameMessage(n,s,o)&&i.push("message-same-name"),e.isSameHeaderMessage(n,s,o)&&i.push("message-same-header"),e.isSameFooterMessage(n,s,o)&&i.push("message-same-footer"),e.isSameAvatarMessage(n,s,o)&&i.push("message-same-avatar");var l=e.isCustomClassMessage(n,s,o);l&&l.length&&("string"==typeof l&&(l=l.split(" ")),l.forEach(function(e){i.push(e)})),r.removeClass("message-first message-last message-tail message-same-name message-same-header message-same-footer message-same-avatar"),i.forEach(function(e){r.addClass(e)})})},t.prototype.clear=function(){this.messages=[],this.$el.html("")},t.prototype.removeMessage=function(e,t){void 0===t&&(t=!0);var a,r,i=this;return"number"==typeof e?(a=e,r=i.$el.find(".message, .messages-title").eq(a)):i.messages&&i.messages.indexOf(e)>=0?(a=i.messages.indexOf(e),r=i.$el.children().eq(a)):a=(r=$(e)).index(),0===r.length?i:(r.remove(),i.messages.splice(a,1),i.params.autoLayout&&t&&i.layout(),i)},t.prototype.removeMessages=function(e,t){void 0===t&&(t=!0);var a=this;if(Array.isArray(e)){var r=[];e.forEach(function(e){r.push(a.$el.find(".message, .messages-title").eq(e))}),r.forEach(function(e){a.removeMessage(e,!1)})}else $(e).each(function(e,t){a.removeMessage(t,!1)});return a.params.autoLayout&&t&&a.layout(),a},t.prototype.addMessage=function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var i,n,s;return"boolean"==typeof a[1]?(i=(e=a)[0],n=e[1],s=e[2]):(i=(t=a)[0],s=t[1],n=t[2]),void 0===n&&(n=!0),void 0===s&&(s=this.params.newMessagesFirst?"prepend":"append"),this.addMessages([i],n,s)},t.prototype.addMessages=function(){for(var e,t,a=[],r=arguments.length;r--;)a[r]=arguments[r];var i,n,s,o=this;"boolean"==typeof a[1]?(i=(e=a)[0],n=e[1],s=e[2]):(i=(t=a)[0],s=t[1],n=t[2]),void 0===n&&(n=!0),void 0===s&&(s=o.params.newMessagesFirst?"prepend":"append");var l=o.pageContentEl.scrollHeight,p=o.pageContentEl.offsetHeight,c=o.pageContentEl.scrollTop,d="",u=o.messages.filter(function(e){return e.isTyping})[0];i.forEach(function(e){u?"append"===s?o.messages.splice(o.messages.indexOf(u),0,e):o.messages.splice(o.messages.indexOf(u)+1,0,e):o.messages["append"===s?"push":"unshift"](e),d+=o.renderMessage(e)});var h=$(d);if(n&&("append"!==s||o.params.newMessagesFirst||h.addClass("message-appear-from-bottom"),"prepend"===s&&o.params.newMessagesFirst&&h.addClass("message-appear-from-top")),u?"append"===s?h.insertBefore(o.$el.find(".message-typing")):h.insertAfter(o.$el.find(".message-typing")):o.$el[s](h),o.params.autoLayout&&o.layout(),"prepend"!==s||u||(o.pageContentEl.scrollTop=c+(o.pageContentEl.scrollHeight-l)),o.params.scrollMessages&&("append"===s&&!o.params.newMessagesFirst||"prepend"===s&&o.params.newMessagesFirst&&!u))if(o.params.scrollMessagesOnEdge){var f=!1;o.params.newMessagesFirst&&0===c&&(f=!0),!o.params.newMessagesFirst&&c-(l-p)>=-10&&(f=!0),f&&o.scroll(n?void 0:0)}else o.scroll(n?void 0:0);return o},t.prototype.showTyping=function(e){void 0===e&&(e={});var t=this,a=t.messages.filter(function(e){return e.isTyping})[0];return a&&t.removeMessage(t.messages.indexOf(a)),t.addMessage(Utils.extend({type:"received",isTyping:!0},e)),t},t.prototype.hideTyping=function(){var e,t,a=this;if(a.messages.forEach(function(t,a){t.isTyping&&(e=a)}),void 0!==e&&a.$el.find(".message").eq(e).hasClass("message-typing")&&(t=!0,a.removeMessage(e)),!t){var r=a.$el.find(".message-typing");r.length&&a.removeMessage(r)}return a},t.prototype.scroll=function(e,t){void 0===e&&(e=300);var a,r=this,i=r.pageContentEl.scrollTop;if(void 0!==t)a=t;else if((a=r.params.newMessagesFirst?0:r.pageContentEl.scrollHeight-r.pageContentEl.offsetHeight)===i)return r;return r.$pageContentEl.scrollTop(a,e),r},t.prototype.init=function(){var e=this;e.messages&&0!==e.messages.length||(e.messages=e.getMessagesData()),e.params.messages&&e.params.messages.length&&e.renderMessages(),e.params.autoLayout&&e.layout(),e.params.scrollMessages&&e.scroll(0)},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy messagesBeforeDestroy",e),e.$el.trigger("messages:beforedestroy",e),e.$el[0]&&(e.$el[0].f7Messages=null,delete e.$el[0].f7Messages),Utils.deleteProps(e)},t}(Framework7Class),Messages$1={name:"messages",static:{Messages:Messages},create:function(){this.messages=ConstructorMethods({defaultSelector:".messages",constructor:Messages,app:this,domProp:"f7Messages",addMethods:"renderMessages layout scroll clear removeMessage removeMessages addMessage addMessages".split(" ")})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".messages-init").each(function(e,a){t.messages.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".messages-init").each(function(e,a){t.messages.create({el:a})})},pageBeforeRemove:function(e){var t=this;e.$el.find(".messages-init").each(function(e,a){t.messages.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".messages-init").each(function(e,a){t.messages.create({el:a})})}},vnode:{"messages-init":{insert:function(e){var t=e.elm;this.messages.create({el:t})},destroy:function(e){var t=e.elm;this.messages.destroy(t)}}}},Messagebar=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i={top:!1,topOffset:0,bottomOffset:0,attachments:[],renderAttachments:void 0,renderAttachment:void 0,maxHeight:null,resizePage:!0};r.useModulesParams(i),r.params=Utils.extend(i,a);var n=$(r.params.el);if(0===n.length)return r;if(n[0].f7Messagebar)return n[0].f7Messagebar;n[0].f7Messagebar=r;var s,o=n.parents(".page").eq(0),l=o.find(".page-content").eq(0),p=n.find(".messagebar-area");s=r.params.textareaEl?$(r.params.textareaEl):n.find("textarea");var c=n.find(".messagebar-attachments"),d=n.find(".messagebar-sheet");function u(){r.params.resizePage&&r.resizePage()}function h(e){e.preventDefault()}function f(e){var t=$(this).index();$(e.target).closest(".messagebar-attachment-delete").length?($(this).trigger("messagebar:attachmentdelete",t),r.emit("local::attachmentDelete messagebarAttachmentDelete",r,this,t)):($(this).trigger("messagebar:attachmentclick",t),r.emit("local::attachmentClick messagebarAttachmentClick",r,this,t))}function v(){r.checkEmptyState(),r.$el.trigger("messagebar:change"),r.emit("local::change messagebarChange",r)}function m(){r.sheetHide(),r.$el.addClass("messagebar-focused"),r.$el.trigger("messagebar:focus"),r.emit("local::focus messagebarFocus",r)}function g(){r.$el.removeClass("messagebar-focused"),r.$el.trigger("messagebar:blur"),r.emit("local::blur messagebarBlur",r)}return r.params.top&&n.addClass("messagebar-top"),Utils.extend(r,{$el:n,el:n[0],$areaEl:p,areaEl:p[0],$textareaEl:s,textareaEl:s[0],$attachmentsEl:c,attachmentsEl:c[0],attachmentsVisible:c.hasClass("messagebar-attachments-visible"),$sheetEl:d,sheetEl:d[0],sheetVisible:d.hasClass("messagebar-sheet-visible"),$pageEl:o,pageEl:o[0],$pageContentEl:l,pageContentEl:l,top:n.hasClass("messagebar-top")||r.params.top,attachments:[]}),r.attachEvents=function(){n.on("textarea:resize",u),n.on("submit",h),n.on("click",".messagebar-attachment",f),s.on("change input",v),s.on("focus",m),s.on("blur",g),t.on("resize",u)},r.detachEvents=function(){n.off("textarea:resize",u),n.off("submit",h),n.off("click",".messagebar-attachment",f),s.off("change input",v),s.off("focus",m),s.off("blur",g),t.off("resize",u)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.focus=function(){return this.$textareaEl.focus(),this},t.prototype.blur=function(){return this.$textareaEl.blur(),this},t.prototype.clear=function(){return this.$textareaEl.val("").trigger("change"),this},t.prototype.getValue=function(){return this.$textareaEl.val().trim()},t.prototype.setValue=function(e){return this.$textareaEl.val(e).trigger("change"),this},t.prototype.setPlaceholder=function(e){return this.$textareaEl.attr("placeholder",e),this},t.prototype.resizePage=function(){var e=this.params,t=this.$el,a=this.top,r=this.$pageEl,i=this.$pageContentEl,n=this.$areaEl,s=this.$textareaEl,o=this.$sheetEl,l=this.$attachmentsEl,p=t[0].offsetHeight,c=e.maxHeight;if(a);else{var d=parseInt(i.css("padding-bottom"),10),u=p+e.bottomOffset;if(u!==d&&i.length){var h=parseInt(i.css("padding-top"),10),f=i[0].scrollHeight,v=i[0].offsetHeight,m=i[0].scrollTop===f-v;c||(c=r[0].offsetHeight-h-o.outerHeight()-l.outerHeight()-parseInt(n.css("margin-top"),10)-parseInt(n.css("margin-bottom"),10)),s.css("max-height",c+"px"),i.css("padding-bottom",u+"px"),m&&i.scrollTop(i[0].scrollHeight-v),t.trigger("messagebar:resizepage"),this.emit("local::resizePage messagebarResizePage",this)}}},t.prototype.checkEmptyState=function(){var e=this.$el,t=this.$textareaEl.val().trim();t&&t.length?e.addClass("messagebar-with-value"):e.removeClass("messagebar-with-value")},t.prototype.attachmentsCreate=function(e){void 0===e&&(e="");var t=$('<div class="messagebar-attachments">'+e+"</div>");return t.insertBefore(this.$textareaEl),Utils.extend(this,{$attachmentsEl:t,attachmentsEl:t[0]}),this},t.prototype.attachmentsShow=function(e){void 0===e&&(e="");return this.$attachmentsEl=this.$el.find(".messagebar-attachments"),0===this.$attachmentsEl.length&&this.attachmentsCreate(e),this.$el.addClass("messagebar-attachments-visible"),this.attachmentsVisible=!0,this.params.resizePage&&this.resizePage(),this},t.prototype.attachmentsHide=function(){return this.$el.removeClass("messagebar-attachments-visible"),this.attachmentsVisible=!1,this.params.resizePage&&this.resizePage(),this},t.prototype.attachmentsToggle=function(){return this.attachmentsVisible?this.attachmentsHide():this.attachmentsShow(),this},t.prototype.renderAttachment=function(e){return this.params.renderAttachment?this.params.renderAttachment.call(this,e):'\n      <div class="messagebar-attachment">\n        <img src="'+e+'">\n        <span class="messagebar-attachment-delete"></span>\n      </div>\n    '},t.prototype.renderAttachments=function(){var e,t=this;e=t.params.renderAttachments?t.params.renderAttachments.call(t,t.attachments):""+t.attachments.map(function(e){return t.renderAttachment(e)}).join(""),0===t.$attachmentsEl.length?t.attachmentsCreate(e):t.$attachmentsEl.html(e)},t.prototype.sheetCreate=function(e){void 0===e&&(e="");var t=$('<div class="messagebar-sheet">'+e+"</div>");return this.$el.append(t),Utils.extend(this,{$sheetEl:t,sheetEl:t[0]}),this},t.prototype.sheetShow=function(e){void 0===e&&(e="");return this.$sheetEl=this.$el.find(".messagebar-sheet"),0===this.$sheetEl.length&&this.sheetCreate(e),this.$el.addClass("messagebar-sheet-visible"),this.sheetVisible=!0,this.params.resizePage&&this.resizePage(),this},t.prototype.sheetHide=function(){return this.$el.removeClass("messagebar-sheet-visible"),this.sheetVisible=!1,this.params.resizePage&&this.resizePage(),this},t.prototype.sheetToggle=function(){return this.sheetVisible?this.sheetHide():this.sheetShow(),this},t.prototype.init=function(){return this.attachEvents(),this.checkEmptyState(),this},t.prototype.destroy=function(){this.emit("local::beforeDestroy messagebarBeforeDestroy",this),this.$el.trigger("messagebar:beforedestroy",this),this.detachEvents(),this.$el[0]&&(this.$el[0].f7Messagebar=null,delete this.$el[0].f7Messagebar),Utils.deleteProps(this)},t}(Framework7Class),Messagebar$1={name:"messagebar",static:{Messagebar:Messagebar},create:function(){this.messagebar=ConstructorMethods({defaultSelector:".messagebar",constructor:Messagebar,app:this,domProp:"f7Messagebar",addMethods:"clear getValue setValue setPlaceholder resizePage focus blur attachmentsCreate attachmentsShow attachmentsHide attachmentsToggle renderAttachments sheetCreate sheetShow sheetHide sheetToggle".split(" ")})},on:{tabBeforeRemove:function(e){var t=this;$(e).find(".messagebar-init").each(function(e,a){t.messagebar.destroy(a)})},tabMounted:function(e){var t=this;$(e).find(".messagebar-init").each(function(e,a){t.messagebar.create(Utils.extend({el:a},$(a).dataset()))})},pageBeforeRemove:function(e){var t=this;e.$el.find(".messagebar-init").each(function(e,a){t.messagebar.destroy(a)})},pageInit:function(e){var t=this;e.$el.find(".messagebar-init").each(function(e,a){t.messagebar.create(Utils.extend({el:a},$(a).dataset()))})}},vnode:{"messagebar-init":{insert:function(e){var t=e.elm;this.messagebar.create(Utils.extend({el:t},$(t).dataset()))},destroy:function(e){var t=e.elm;this.messagebar.destroy(t)}}}},Browser=function(){return{isIE:!!win.navigator.userAgent.match(/Trident/g)||!!win.navigator.userAgent.match(/MSIE/g),isSafari:(e=win.navigator.userAgent.toLowerCase(),e.indexOf("safari")>=0&&e.indexOf("chrome")<0&&e.indexOf("android")<0),isUiWebView:/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i.test(win.navigator.userAgent)};var e}();function updateSize(){var e,t,a=this.$el;e=void 0!==this.params.width?this.params.width:a[0].clientWidth,t=void 0!==this.params.height?this.params.height:a[0].clientHeight,0===e&&this.isHorizontal()||0===t&&this.isVertical()||(e=e-parseInt(a.css("padding-left"),10)-parseInt(a.css("padding-right"),10),t=t-parseInt(a.css("padding-top"),10)-parseInt(a.css("padding-bottom"),10),Utils.extend(this,{width:e,height:t,size:this.isHorizontal()?e:t}))}function updateSlides(){var e=this.params,t=this.$wrapperEl,a=this.size,r=this.rtlTranslate,i=this.wrongRTL,n=this.virtual&&e.virtual.enabled,s=n?this.virtual.slides.length:this.slides.length,o=t.children("."+this.params.slideClass),l=n?this.virtual.slides.length:o.length,p=[],c=[],d=[],u=e.slidesOffsetBefore;"function"==typeof u&&(u=e.slidesOffsetBefore.call(this));var h=e.slidesOffsetAfter;"function"==typeof h&&(h=e.slidesOffsetAfter.call(this));var f=this.snapGrid.length,v=this.snapGrid.length,m=e.spaceBetween,g=-u,b=0,y=0;if(void 0!==a){var w,C;"string"==typeof m&&m.indexOf("%")>=0&&(m=parseFloat(m.replace("%",""))/100*a),this.virtualSize=-m,r?o.css({marginLeft:"",marginTop:""}):o.css({marginRight:"",marginBottom:""}),e.slidesPerColumn>1&&(w=Math.floor(l/e.slidesPerColumn)===l/this.params.slidesPerColumn?l:Math.ceil(l/e.slidesPerColumn)*e.slidesPerColumn,"auto"!==e.slidesPerView&&"row"===e.slidesPerColumnFill&&(w=Math.max(w,e.slidesPerView*e.slidesPerColumn)));for(var x,$=e.slidesPerColumn,k=w/$,E=Math.floor(l/e.slidesPerColumn),S=0;S<l;S+=1){C=0;var T=o.eq(S);if(e.slidesPerColumn>1){var M=void 0,P=void 0,O=void 0;"column"===e.slidesPerColumnFill?(O=S-(P=Math.floor(S/$))*$,(P>E||P===E&&O===$-1)&&(O+=1)>=$&&(O=0,P+=1),M=P+O*w/$,T.css({"-webkit-box-ordinal-group":M,"-moz-box-ordinal-group":M,"-ms-flex-order":M,"-webkit-order":M,order:M})):P=S-(O=Math.floor(S/k))*k,T.css("margin-"+(this.isHorizontal()?"top":"left"),0!==O&&e.spaceBetween&&e.spaceBetween+"px").attr("data-swiper-column",P).attr("data-swiper-row",O)}if("none"!==T.css("display")){if("auto"===e.slidesPerView){var D=win.getComputedStyle(T[0],null),I=T[0].style.transform,R=T[0].style.webkitTransform;if(I&&(T[0].style.transform="none"),R&&(T[0].style.webkitTransform="none"),e.roundLengths)C=this.isHorizontal()?T.outerWidth(!0):T.outerHeight(!0);else if(this.isHorizontal()){var B=parseFloat(D.getPropertyValue("width")),L=parseFloat(D.getPropertyValue("padding-left")),A=parseFloat(D.getPropertyValue("padding-right")),z=parseFloat(D.getPropertyValue("margin-left")),H=parseFloat(D.getPropertyValue("margin-right")),U=D.getPropertyValue("box-sizing");C=U&&"border-box"===U?B+z+H:B+L+A+z+H}else{var N=parseFloat(D.getPropertyValue("height")),V=parseFloat(D.getPropertyValue("padding-top")),F=parseFloat(D.getPropertyValue("padding-bottom")),j=parseFloat(D.getPropertyValue("margin-top")),q=parseFloat(D.getPropertyValue("margin-bottom")),Y=D.getPropertyValue("box-sizing");C=Y&&"border-box"===Y?N+j+q:N+V+F+j+q}I&&(T[0].style.transform=I),R&&(T[0].style.webkitTransform=R),e.roundLengths&&(C=Math.floor(C))}else C=(a-(e.slidesPerView-1)*m)/e.slidesPerView,e.roundLengths&&(C=Math.floor(C)),o[S]&&(this.isHorizontal()?o[S].style.width=C+"px":o[S].style.height=C+"px");o[S]&&(o[S].swiperSlideSize=C),d.push(C),e.centeredSlides?(g=g+C/2+b/2+m,0===b&&0!==S&&(g=g-a/2-m),0===S&&(g=g-a/2-m),Math.abs(g)<.001&&(g=0),e.roundLengths&&(g=Math.floor(g)),y%e.slidesPerGroup==0&&p.push(g),c.push(g)):(e.roundLengths&&(g=Math.floor(g)),y%e.slidesPerGroup==0&&p.push(g),c.push(g),g=g+C+m),this.virtualSize+=C+m,b=C,y+=1}}if(this.virtualSize=Math.max(this.virtualSize,a)+h,r&&i&&("slide"===e.effect||"coverflow"===e.effect)&&t.css({width:this.virtualSize+e.spaceBetween+"px"}),Support.flexbox&&!e.setWrapperSize||(this.isHorizontal()?t.css({width:this.virtualSize+e.spaceBetween+"px"}):t.css({height:this.virtualSize+e.spaceBetween+"px"})),e.slidesPerColumn>1&&(this.virtualSize=(C+e.spaceBetween)*w,this.virtualSize=Math.ceil(this.virtualSize/e.slidesPerColumn)-e.spaceBetween,this.isHorizontal()?t.css({width:this.virtualSize+e.spaceBetween+"px"}):t.css({height:this.virtualSize+e.spaceBetween+"px"}),e.centeredSlides)){x=[];for(var _=0;_<p.length;_+=1){var W=p[_];e.roundLengths&&(W=Math.floor(W)),p[_]<this.virtualSize+p[0]&&x.push(W)}p=x}if(!e.centeredSlides){x=[];for(var X=0;X<p.length;X+=1){var G=p[X];e.roundLengths&&(G=Math.floor(G)),p[X]<=this.virtualSize-a&&x.push(G)}p=x,Math.floor(this.virtualSize-a)-Math.floor(p[p.length-1])>1&&p.push(this.virtualSize-a)}if(0===p.length&&(p=[0]),0!==e.spaceBetween&&(this.isHorizontal()?r?o.css({marginLeft:m+"px"}):o.css({marginRight:m+"px"}):o.css({marginBottom:m+"px"})),e.centerInsufficientSlides){var J=0;if(d.forEach(function(t){J+=t+(e.spaceBetween?e.spaceBetween:0)}),(J-=e.spaceBetween)<a){var Q=(a-J)/2;p.forEach(function(e,t){p[t]=e-Q}),c.forEach(function(e,t){c[t]=e+Q})}}Utils.extend(this,{slides:o,snapGrid:p,slidesGrid:c,slidesSizesGrid:d}),l!==s&&this.emit("slidesLengthChange"),p.length!==f&&(this.params.watchOverflow&&this.checkOverflow(),this.emit("snapGridLengthChange")),c.length!==v&&this.emit("slidesGridLengthChange"),(e.watchSlidesProgress||e.watchSlidesVisibility)&&this.updateSlidesOffset()}}function updateAutoHeight(e){var t,a=[],r=0;if("number"==typeof e?this.setTransition(e):!0===e&&this.setTransition(this.params.speed),"auto"!==this.params.slidesPerView&&this.params.slidesPerView>1)for(t=0;t<Math.ceil(this.params.slidesPerView);t+=1){var i=this.activeIndex+t;if(i>this.slides.length)break;a.push(this.slides.eq(i)[0])}else a.push(this.slides.eq(this.activeIndex)[0]);for(t=0;t<a.length;t+=1)if(void 0!==a[t]){var n=a[t].offsetHeight;r=n>r?n:r}r&&this.$wrapperEl.css("height",r+"px")}function updateSlidesOffset(){for(var e=this.slides,t=0;t<e.length;t+=1)e[t].swiperSlideOffset=this.isHorizontal()?e[t].offsetLeft:e[t].offsetTop}function updateSlidesProgress(e){void 0===e&&(e=this&&this.translate||0);var t=this.params,a=this.slides,r=this.rtlTranslate;if(0!==a.length){void 0===a[0].swiperSlideOffset&&this.updateSlidesOffset();var i=-e;r&&(i=e),a.removeClass(t.slideVisibleClass),this.visibleSlidesIndexes=[],this.visibleSlides=[];for(var n=0;n<a.length;n+=1){var s=a[n],o=(i+(t.centeredSlides?this.minTranslate():0)-s.swiperSlideOffset)/(s.swiperSlideSize+t.spaceBetween);if(t.watchSlidesVisibility){var l=-(i-s.swiperSlideOffset),p=l+this.slidesSizesGrid[n];(l>=0&&l<this.size||p>0&&p<=this.size||l<=0&&p>=this.size)&&(this.visibleSlides.push(s),this.visibleSlidesIndexes.push(n),a.eq(n).addClass(t.slideVisibleClass))}s.progress=r?-o:o}this.visibleSlides=$(this.visibleSlides)}}function updateProgress(e){void 0===e&&(e=this&&this.translate||0);var t=this.params,a=this.maxTranslate()-this.minTranslate(),r=this.progress,i=this.isBeginning,n=this.isEnd,s=i,o=n;0===a?(r=0,i=!0,n=!0):(i=(r=(e-this.minTranslate())/a)<=0,n=r>=1),Utils.extend(this,{progress:r,isBeginning:i,isEnd:n}),(t.watchSlidesProgress||t.watchSlidesVisibility)&&this.updateSlidesProgress(e),i&&!s&&this.emit("reachBeginning toEdge"),n&&!o&&this.emit("reachEnd toEdge"),(s&&!i||o&&!n)&&this.emit("fromEdge"),this.emit("progress",r)}function updateSlidesClasses(){var e,t=this.slides,a=this.params,r=this.$wrapperEl,i=this.activeIndex,n=this.realIndex,s=this.virtual&&a.virtual.enabled;t.removeClass(a.slideActiveClass+" "+a.slideNextClass+" "+a.slidePrevClass+" "+a.slideDuplicateActiveClass+" "+a.slideDuplicateNextClass+" "+a.slideDuplicatePrevClass),(e=s?this.$wrapperEl.find("."+a.slideClass+'[data-swiper-slide-index="'+i+'"]'):t.eq(i)).addClass(a.slideActiveClass),a.loop&&(e.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+n+'"]').addClass(a.slideDuplicateActiveClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+n+'"]').addClass(a.slideDuplicateActiveClass));var o=e.nextAll("."+a.slideClass).eq(0).addClass(a.slideNextClass);a.loop&&0===o.length&&(o=t.eq(0)).addClass(a.slideNextClass);var l=e.prevAll("."+a.slideClass).eq(0).addClass(a.slidePrevClass);a.loop&&0===l.length&&(l=t.eq(-1)).addClass(a.slidePrevClass),a.loop&&(o.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+o.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicateNextClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+o.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicateNextClass),l.hasClass(a.slideDuplicateClass)?r.children("."+a.slideClass+":not(."+a.slideDuplicateClass+')[data-swiper-slide-index="'+l.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicatePrevClass):r.children("."+a.slideClass+"."+a.slideDuplicateClass+'[data-swiper-slide-index="'+l.attr("data-swiper-slide-index")+'"]').addClass(a.slideDuplicatePrevClass))}function updateActiveIndex(e){var t,a=this.rtlTranslate?this.translate:-this.translate,r=this.slidesGrid,i=this.snapGrid,n=this.params,s=this.activeIndex,o=this.realIndex,l=this.snapIndex,p=e;if(void 0===p){for(var c=0;c<r.length;c+=1)void 0!==r[c+1]?a>=r[c]&&a<r[c+1]-(r[c+1]-r[c])/2?p=c:a>=r[c]&&a<r[c+1]&&(p=c+1):a>=r[c]&&(p=c);n.normalizeSlideIndex&&(p<0||void 0===p)&&(p=0)}if((t=i.indexOf(a)>=0?i.indexOf(a):Math.floor(p/n.slidesPerGroup))>=i.length&&(t=i.length-1),p!==s){var d=parseInt(this.slides.eq(p).attr("data-swiper-slide-index")||p,10);Utils.extend(this,{snapIndex:t,realIndex:d,previousIndex:s,activeIndex:p}),this.emit("activeIndexChange"),this.emit("snapIndexChange"),o!==d&&this.emit("realIndexChange"),this.emit("slideChange")}else t!==l&&(this.snapIndex=t,this.emit("snapIndexChange"))}function updateClickedSlide(e){var t=this.params,a=$(e.target).closest("."+t.slideClass)[0],r=!1;if(a)for(var i=0;i<this.slides.length;i+=1)this.slides[i]===a&&(r=!0);if(!a||!r)return this.clickedSlide=void 0,void(this.clickedIndex=void 0);this.clickedSlide=a,this.virtual&&this.params.virtual.enabled?this.clickedIndex=parseInt($(a).attr("data-swiper-slide-index"),10):this.clickedIndex=$(a).index(),t.slideToClickedSlide&&void 0!==this.clickedIndex&&this.clickedIndex!==this.activeIndex&&this.slideToClickedSlide()}var update={updateSize:updateSize,updateSlides:updateSlides,updateAutoHeight:updateAutoHeight,updateSlidesOffset:updateSlidesOffset,updateSlidesProgress:updateSlidesProgress,updateProgress:updateProgress,updateSlidesClasses:updateSlidesClasses,updateActiveIndex:updateActiveIndex,updateClickedSlide:updateClickedSlide};function getTranslate(e){void 0===e&&(e=this.isHorizontal()?"x":"y");var t=this.params,a=this.rtlTranslate,r=this.translate,i=this.$wrapperEl;if(t.virtualTranslate)return a?-r:r;var n=Utils.getTranslate(i[0],e);return a&&(n=-n),n||0}function setTranslate(e,t){var a=this.rtlTranslate,r=this.params,i=this.$wrapperEl,n=this.progress,s=0,o=0;this.isHorizontal()?s=a?-e:e:o=e,r.roundLengths&&(s=Math.floor(s),o=Math.floor(o)),r.virtualTranslate||(Support.transforms3d?i.transform("translate3d("+s+"px, "+o+"px, 0px)"):i.transform("translate("+s+"px, "+o+"px)")),this.previousTranslate=this.translate,this.translate=this.isHorizontal()?s:o;var l=this.maxTranslate()-this.minTranslate();(0===l?0:(e-this.minTranslate())/l)!==n&&this.updateProgress(e),this.emit("setTranslate",this.translate,t)}function minTranslate(){return-this.snapGrid[0]}function maxTranslate(){return-this.snapGrid[this.snapGrid.length-1]}var translate={getTranslate:getTranslate,setTranslate:setTranslate,minTranslate:minTranslate,maxTranslate:maxTranslate};function setTransition(e,t){this.$wrapperEl.transition(e),this.emit("setTransition",e,t)}function transitionStart(e,t){void 0===e&&(e=!0);var a=this.activeIndex,r=this.params,i=this.previousIndex;r.autoHeight&&this.updateAutoHeight();var n=t;if(n||(n=a>i?"next":a<i?"prev":"reset"),this.emit("transitionStart"),e&&a!==i){if("reset"===n)return void this.emit("slideResetTransitionStart");this.emit("slideChangeTransitionStart"),"next"===n?this.emit("slideNextTransitionStart"):this.emit("slidePrevTransitionStart")}}function transitionEnd$1(e,t){void 0===e&&(e=!0);var a=this.activeIndex,r=this.previousIndex;this.animating=!1,this.setTransition(0);var i=t;if(i||(i=a>r?"next":a<r?"prev":"reset"),this.emit("transitionEnd"),e&&a!==r){if("reset"===i)return void this.emit("slideResetTransitionEnd");this.emit("slideChangeTransitionEnd"),"next"===i?this.emit("slideNextTransitionEnd"):this.emit("slidePrevTransitionEnd")}}var transition$1={setTransition:setTransition,transitionStart:transitionStart,transitionEnd:transitionEnd$1};function slideTo(e,t,a,r){void 0===e&&(e=0),void 0===t&&(t=this.params.speed),void 0===a&&(a=!0);var i=this,n=e;n<0&&(n=0);var s=i.params,o=i.snapGrid,l=i.slidesGrid,p=i.previousIndex,c=i.activeIndex,d=i.rtlTranslate;if(i.animating&&s.preventInteractionOnTransition)return!1;var u=Math.floor(n/s.slidesPerGroup);u>=o.length&&(u=o.length-1),(c||s.initialSlide||0)===(p||0)&&a&&i.emit("beforeSlideChangeStart");var h,f=-o[u];if(i.updateProgress(f),s.normalizeSlideIndex)for(var v=0;v<l.length;v+=1)-Math.floor(100*f)>=Math.floor(100*l[v])&&(n=v);if(i.initialized&&n!==c){if(!i.allowSlideNext&&f<i.translate&&f<i.minTranslate())return!1;if(!i.allowSlidePrev&&f>i.translate&&f>i.maxTranslate()&&(c||0)!==n)return!1}return h=n>c?"next":n<c?"prev":"reset",d&&-f===i.translate||!d&&f===i.translate?(i.updateActiveIndex(n),s.autoHeight&&i.updateAutoHeight(),i.updateSlidesClasses(),"slide"!==s.effect&&i.setTranslate(f),"reset"!==h&&(i.transitionStart(a,h),i.transitionEnd(a,h)),!1):(0!==t&&Support.transition?(i.setTransition(t),i.setTranslate(f),i.updateActiveIndex(n),i.updateSlidesClasses(),i.emit("beforeTransitionStart",t,r),i.transitionStart(a,h),i.animating||(i.animating=!0,i.onSlideToWrapperTransitionEnd||(i.onSlideToWrapperTransitionEnd=function(e){i&&!i.destroyed&&e.target===this&&(i.$wrapperEl[0].removeEventListener("transitionend",i.onSlideToWrapperTransitionEnd),i.$wrapperEl[0].removeEventListener("webkitTransitionEnd",i.onSlideToWrapperTransitionEnd),i.onSlideToWrapperTransitionEnd=null,delete i.onSlideToWrapperTransitionEnd,i.transitionEnd(a,h))}),i.$wrapperEl[0].addEventListener("transitionend",i.onSlideToWrapperTransitionEnd),i.$wrapperEl[0].addEventListener("webkitTransitionEnd",i.onSlideToWrapperTransitionEnd))):(i.setTransition(0),i.setTranslate(f),i.updateActiveIndex(n),i.updateSlidesClasses(),i.emit("beforeTransitionStart",t,r),i.transitionStart(a,h),i.transitionEnd(a,h)),!0)}function slideToLoop(e,t,a,r){void 0===e&&(e=0),void 0===t&&(t=this.params.speed),void 0===a&&(a=!0);var i=e;return this.params.loop&&(i+=this.loopedSlides),this.slideTo(i,t,a,r)}function slideNext(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.params,i=this.animating;return r.loop?!i&&(this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft,this.slideTo(this.activeIndex+r.slidesPerGroup,e,t,a)):this.slideTo(this.activeIndex+r.slidesPerGroup,e,t,a)}function slidePrev(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.params,i=this.animating,n=this.snapGrid,s=this.slidesGrid,o=this.rtlTranslate;if(r.loop){if(i)return!1;this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft}function l(e){return e<0?-Math.floor(Math.abs(e)):Math.floor(e)}var p,c=l(o?this.translate:-this.translate),d=n.map(function(e){return l(e)}),u=(s.map(function(e){return l(e)}),n[d.indexOf(c)],n[d.indexOf(c)-1]);return void 0!==u&&(p=s.indexOf(u))<0&&(p=this.activeIndex-1),this.slideTo(p,e,t,a)}function slideReset(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);return this.slideTo(this.activeIndex,e,t,a)}function slideToClosest(e,t,a){void 0===e&&(e=this.params.speed),void 0===t&&(t=!0);var r=this.activeIndex,i=Math.floor(r/this.params.slidesPerGroup);if(i<this.snapGrid.length-1){var n=this.rtlTranslate?this.translate:-this.translate,s=this.snapGrid[i];n-s>(this.snapGrid[i+1]-s)/2&&(r=this.params.slidesPerGroup)}return this.slideTo(r,e,t,a)}function slideToClickedSlide(){var e,t=this,a=t.params,r=t.$wrapperEl,i="auto"===a.slidesPerView?t.slidesPerViewDynamic():a.slidesPerView,n=t.clickedIndex;if(a.loop){if(t.animating)return;e=parseInt($(t.clickedSlide).attr("data-swiper-slide-index"),10),a.centeredSlides?n<t.loopedSlides-i/2||n>t.slides.length-t.loopedSlides+i/2?(t.loopFix(),n=r.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]:not(.'+a.slideDuplicateClass+")").eq(0).index(),Utils.nextTick(function(){t.slideTo(n)})):t.slideTo(n):n>t.slides.length-i?(t.loopFix(),n=r.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]:not(.'+a.slideDuplicateClass+")").eq(0).index(),Utils.nextTick(function(){t.slideTo(n)})):t.slideTo(n)}else t.slideTo(n)}var slide={slideTo:slideTo,slideToLoop:slideToLoop,slideNext:slideNext,slidePrev:slidePrev,slideReset:slideReset,slideToClosest:slideToClosest,slideToClickedSlide:slideToClickedSlide};function loopCreate(){var e=this,t=e.params,a=e.$wrapperEl;a.children("."+t.slideClass+"."+t.slideDuplicateClass).remove();var r=a.children("."+t.slideClass);if(t.loopFillGroupWithBlank){var i=t.slidesPerGroup-r.length%t.slidesPerGroup;if(i!==t.slidesPerGroup){for(var n=0;n<i;n+=1){var s=$(doc.createElement("div")).addClass(t.slideClass+" "+t.slideBlankClass);a.append(s)}r=a.children("."+t.slideClass)}}"auto"!==t.slidesPerView||t.loopedSlides||(t.loopedSlides=r.length),e.loopedSlides=parseInt(t.loopedSlides||t.slidesPerView,10),e.loopedSlides+=t.loopAdditionalSlides,e.loopedSlides>r.length&&(e.loopedSlides=r.length);var o=[],l=[];r.each(function(t,a){var i=$(a);t<e.loopedSlides&&l.push(a),t<r.length&&t>=r.length-e.loopedSlides&&o.push(a),i.attr("data-swiper-slide-index",t)});for(var p=0;p<l.length;p+=1)a.append($(l[p].cloneNode(!0)).addClass(t.slideDuplicateClass));for(var c=o.length-1;c>=0;c-=1)a.prepend($(o[c].cloneNode(!0)).addClass(t.slideDuplicateClass))}function loopFix(){var e,t=this.params,a=this.activeIndex,r=this.slides,i=this.loopedSlides,n=this.allowSlidePrev,s=this.allowSlideNext,o=this.snapGrid,l=this.rtlTranslate;this.allowSlidePrev=!0,this.allowSlideNext=!0;var p=-o[a]-this.getTranslate();if(a<i)e=r.length-3*i+a,e+=i,this.slideTo(e,0,!1,!0)&&0!==p&&this.setTranslate((l?-this.translate:this.translate)-p);else if("auto"===t.slidesPerView&&a>=2*i||a>=r.length-i){e=-r.length+a+i,e+=i,this.slideTo(e,0,!1,!0)&&0!==p&&this.setTranslate((l?-this.translate:this.translate)-p)}this.allowSlidePrev=n,this.allowSlideNext=s}function loopDestroy(){var e=this.$wrapperEl,t=this.params,a=this.slides;e.children("."+t.slideClass+"."+t.slideDuplicateClass+",."+t.slideClass+"."+t.slideBlankClass).remove(),a.removeAttr("data-swiper-slide-index")}var loop={loopCreate:loopCreate,loopFix:loopFix,loopDestroy:loopDestroy};function setGrabCursor(e){if(!(Support.touch||!this.params.simulateTouch||this.params.watchOverflow&&this.isLocked)){var t=this.el;t.style.cursor="move",t.style.cursor=e?"-webkit-grabbing":"-webkit-grab",t.style.cursor=e?"-moz-grabbin":"-moz-grab",t.style.cursor=e?"grabbing":"grab"}}function unsetGrabCursor(){Support.touch||this.params.watchOverflow&&this.isLocked||(this.el.style.cursor="")}var grabCursor={setGrabCursor:setGrabCursor,unsetGrabCursor:unsetGrabCursor};function appendSlide(e){var t=this.$wrapperEl,a=this.params;if(a.loop&&this.loopDestroy(),"object"==typeof e&&"length"in e)for(var r=0;r<e.length;r+=1)e[r]&&t.append(e[r]);else t.append(e);a.loop&&this.loopCreate(),a.observer&&Support.observer||this.update()}function prependSlide(e){var t=this.params,a=this.$wrapperEl,r=this.activeIndex;t.loop&&this.loopDestroy();var i=r+1;if("object"==typeof e&&"length"in e){for(var n=0;n<e.length;n+=1)e[n]&&a.prepend(e[n]);i=r+e.length}else a.prepend(e);t.loop&&this.loopCreate(),t.observer&&Support.observer||this.update(),this.slideTo(i,0,!1)}function addSlide(e,t){var a=this.$wrapperEl,r=this.params,i=this.activeIndex;r.loop&&(i-=this.loopedSlides,this.loopDestroy(),this.slides=a.children("."+r.slideClass));var n=this.slides.length;if(e<=0)this.prependSlide(t);else if(e>=n)this.appendSlide(t);else{for(var s=i>e?i+1:i,o=[],l=n-1;l>=e;l-=1){var p=this.slides.eq(l);p.remove(),o.unshift(p)}if("object"==typeof t&&"length"in t){for(var c=0;c<t.length;c+=1)t[c]&&a.append(t[c]);s=i>e?i+t.length:i}else a.append(t);for(var d=0;d<o.length;d+=1)a.append(o[d]);r.loop&&this.loopCreate(),r.observer&&Support.observer||this.update(),r.loop?this.slideTo(s+this.loopedSlides,0,!1):this.slideTo(s,0,!1)}}function removeSlide(e){var t=this.params,a=this.$wrapperEl,r=this.activeIndex;t.loop&&(r-=this.loopedSlides,this.loopDestroy(),this.slides=a.children("."+t.slideClass));var i,n=r;if("object"==typeof e&&"length"in e){for(var s=0;s<e.length;s+=1)i=e[s],this.slides[i]&&this.slides.eq(i).remove(),i<n&&(n-=1);n=Math.max(n,0)}else i=e,this.slides[i]&&this.slides.eq(i).remove(),i<n&&(n-=1),n=Math.max(n,0);t.loop&&this.loopCreate(),t.observer&&Support.observer||this.update(),t.loop?this.slideTo(n+this.loopedSlides,0,!1):this.slideTo(n,0,!1)}function removeAllSlides(){for(var e=[],t=0;t<this.slides.length;t+=1)e.push(t);this.removeSlide(e)}var manipulation={appendSlide:appendSlide,prependSlide:prependSlide,addSlide:addSlide,removeSlide:removeSlide,removeAllSlides:removeAllSlides};function onTouchStart(e){var t=this.touchEventsData,a=this.params,r=this.touches;if(!this.animating||!a.preventInteractionOnTransition){var i=e;if(i.originalEvent&&(i=i.originalEvent),t.isTouchEvent="touchstart"===i.type,(t.isTouchEvent||!("which"in i)||3!==i.which)&&!(!t.isTouchEvent&&"button"in i&&i.button>0||t.isTouched&&t.isMoved))if(a.noSwiping&&$(i.target).closest(a.noSwipingSelector?a.noSwipingSelector:"."+a.noSwipingClass)[0])this.allowClick=!0;else if(!a.swipeHandler||$(i).closest(a.swipeHandler)[0]){r.currentX="touchstart"===i.type?i.targetTouches[0].pageX:i.pageX,r.currentY="touchstart"===i.type?i.targetTouches[0].pageY:i.pageY;var n=r.currentX,s=r.currentY,o=a.edgeSwipeDetection||a.iOSEdgeSwipeDetection,l=a.edgeSwipeThreshold||a.iOSEdgeSwipeThreshold;if(!o||!(n<=l||n>=win.screen.width-l)){if(Utils.extend(t,{isTouched:!0,isMoved:!1,allowTouchCallbacks:!0,isScrolling:void 0,startMoving:void 0}),r.startX=n,r.startY=s,t.touchStartTime=Utils.now(),this.allowClick=!0,this.updateSize(),this.swipeDirection=void 0,a.threshold>0&&(t.allowThresholdMove=!1),"touchstart"!==i.type){var p=!0;$(i.target).is(t.formElements)&&(p=!1),doc.activeElement&&$(doc.activeElement).is(t.formElements)&&doc.activeElement!==i.target&&doc.activeElement.blur();var c=p&&this.allowTouchMove&&a.touchStartPreventDefault;(a.touchStartForcePreventDefault||c)&&i.preventDefault()}this.emit("touchStart",i)}}}}function onTouchMove(e){var t=this.touchEventsData,a=this.params,r=this.touches,i=this.rtlTranslate,n=e;if(n.originalEvent&&(n=n.originalEvent),t.isTouched){if(!t.isTouchEvent||"mousemove"!==n.type){var s="touchmove"===n.type?n.targetTouches[0].pageX:n.pageX,o="touchmove"===n.type?n.targetTouches[0].pageY:n.pageY;if(n.preventedByNestedSwiper)return r.startX=s,void(r.startY=o);if(!this.allowTouchMove)return this.allowClick=!1,void(t.isTouched&&(Utils.extend(r,{startX:s,startY:o,currentX:s,currentY:o}),t.touchStartTime=Utils.now()));if(t.isTouchEvent&&a.touchReleaseOnEdges&&!a.loop)if(this.isVertical()){if(o<r.startY&&this.translate<=this.maxTranslate()||o>r.startY&&this.translate>=this.minTranslate())return t.isTouched=!1,void(t.isMoved=!1)}else if(s<r.startX&&this.translate<=this.maxTranslate()||s>r.startX&&this.translate>=this.minTranslate())return;if(t.isTouchEvent&&doc.activeElement&&n.target===doc.activeElement&&$(n.target).is(t.formElements))return t.isMoved=!0,void(this.allowClick=!1);if(t.allowTouchCallbacks&&this.emit("touchMove",n),!(n.targetTouches&&n.targetTouches.length>1)){r.currentX=s,r.currentY=o;var l=r.currentX-r.startX,p=r.currentY-r.startY;if(!(this.params.threshold&&Math.sqrt(Math.pow(l,2)+Math.pow(p,2))<this.params.threshold)){var c;if(void 0===t.isScrolling)this.isHorizontal()&&r.currentY===r.startY||this.isVertical()&&r.currentX===r.startX?t.isScrolling=!1:l*l+p*p>=25&&(c=180*Math.atan2(Math.abs(p),Math.abs(l))/Math.PI,t.isScrolling=this.isHorizontal()?c>a.touchAngle:90-c>a.touchAngle);if(t.isScrolling&&this.emit("touchMoveOpposite",n),void 0===t.startMoving&&(r.currentX===r.startX&&r.currentY===r.startY||(t.startMoving=!0)),t.isScrolling)t.isTouched=!1;else if(t.startMoving){this.allowClick=!1,n.preventDefault(),a.touchMoveStopPropagation&&!a.nested&&n.stopPropagation(),t.isMoved||(a.loop&&this.loopFix(),t.startTranslate=this.getTranslate(),this.setTransition(0),this.animating&&this.$wrapperEl.trigger("webkitTransitionEnd transitionend"),t.allowMomentumBounce=!1,!a.grabCursor||!0!==this.allowSlideNext&&!0!==this.allowSlidePrev||this.setGrabCursor(!0),this.emit("sliderFirstMove",n)),this.emit("sliderMove",n),t.isMoved=!0;var d=this.isHorizontal()?l:p;r.diff=d,d*=a.touchRatio,i&&(d=-d),this.swipeDirection=d>0?"prev":"next",t.currentTranslate=d+t.startTranslate;var u=!0,h=a.resistanceRatio;if(a.touchReleaseOnEdges&&(h=0),d>0&&t.currentTranslate>this.minTranslate()?(u=!1,a.resistance&&(t.currentTranslate=this.minTranslate()-1+Math.pow(-this.minTranslate()+t.startTranslate+d,h))):d<0&&t.currentTranslate<this.maxTranslate()&&(u=!1,a.resistance&&(t.currentTranslate=this.maxTranslate()+1-Math.pow(this.maxTranslate()-t.startTranslate-d,h))),u&&(n.preventedByNestedSwiper=!0),!this.allowSlideNext&&"next"===this.swipeDirection&&t.currentTranslate<t.startTranslate&&(t.currentTranslate=t.startTranslate),!this.allowSlidePrev&&"prev"===this.swipeDirection&&t.currentTranslate>t.startTranslate&&(t.currentTranslate=t.startTranslate),a.threshold>0){if(!(Math.abs(d)>a.threshold||t.allowThresholdMove))return void(t.currentTranslate=t.startTranslate);if(!t.allowThresholdMove)return t.allowThresholdMove=!0,r.startX=r.currentX,r.startY=r.currentY,t.currentTranslate=t.startTranslate,void(r.diff=this.isHorizontal()?r.currentX-r.startX:r.currentY-r.startY)}a.followFinger&&((a.freeMode||a.watchSlidesProgress||a.watchSlidesVisibility)&&(this.updateActiveIndex(),this.updateSlidesClasses()),a.freeMode&&(0===t.velocities.length&&t.velocities.push({position:r[this.isHorizontal()?"startX":"startY"],time:t.touchStartTime}),t.velocities.push({position:r[this.isHorizontal()?"currentX":"currentY"],time:Utils.now()})),this.updateProgress(t.currentTranslate),this.setTranslate(t.currentTranslate))}}}}}else t.startMoving&&t.isScrolling&&this.emit("touchMoveOpposite",n)}function onTouchEnd(e){var t=this,a=t.touchEventsData,r=t.params,i=t.touches,n=t.rtlTranslate,s=t.$wrapperEl,o=t.slidesGrid,l=t.snapGrid,p=e;if(p.originalEvent&&(p=p.originalEvent),a.allowTouchCallbacks&&t.emit("touchEnd",p),a.allowTouchCallbacks=!1,!a.isTouched)return a.isMoved&&r.grabCursor&&t.setGrabCursor(!1),a.isMoved=!1,void(a.startMoving=!1);r.grabCursor&&a.isMoved&&a.isTouched&&(!0===t.allowSlideNext||!0===t.allowSlidePrev)&&t.setGrabCursor(!1);var c,d=Utils.now(),u=d-a.touchStartTime;if(t.allowClick&&(t.updateClickedSlide(p),t.emit("tap",p),u<300&&d-a.lastClickTime>300&&(a.clickTimeout&&clearTimeout(a.clickTimeout),a.clickTimeout=Utils.nextTick(function(){t&&!t.destroyed&&t.emit("click",p)},300)),u<300&&d-a.lastClickTime<300&&(a.clickTimeout&&clearTimeout(a.clickTimeout),t.emit("doubleTap",p))),a.lastClickTime=Utils.now(),Utils.nextTick(function(){t.destroyed||(t.allowClick=!0)}),!a.isTouched||!a.isMoved||!t.swipeDirection||0===i.diff||a.currentTranslate===a.startTranslate)return a.isTouched=!1,a.isMoved=!1,void(a.startMoving=!1);if(a.isTouched=!1,a.isMoved=!1,a.startMoving=!1,c=r.followFinger?n?t.translate:-t.translate:-a.currentTranslate,r.freeMode){if(c<-t.minTranslate())return void t.slideTo(t.activeIndex);if(c>-t.maxTranslate())return void(t.slides.length<l.length?t.slideTo(l.length-1):t.slideTo(t.slides.length-1));if(r.freeModeMomentum){if(a.velocities.length>1){var h=a.velocities.pop(),f=a.velocities.pop(),v=h.position-f.position,m=h.time-f.time;t.velocity=v/m,t.velocity/=2,Math.abs(t.velocity)<r.freeModeMinimumVelocity&&(t.velocity=0),(m>150||Utils.now()-h.time>300)&&(t.velocity=0)}else t.velocity=0;t.velocity*=r.freeModeMomentumVelocityRatio,a.velocities.length=0;var g=1e3*r.freeModeMomentumRatio,b=t.velocity*g,y=t.translate+b;n&&(y=-y);var w,C,x=!1,$=20*Math.abs(t.velocity)*r.freeModeMomentumBounceRatio;if(y<t.maxTranslate())r.freeModeMomentumBounce?(y+t.maxTranslate()<-$&&(y=t.maxTranslate()-$),w=t.maxTranslate(),x=!0,a.allowMomentumBounce=!0):y=t.maxTranslate(),r.loop&&r.centeredSlides&&(C=!0);else if(y>t.minTranslate())r.freeModeMomentumBounce?(y-t.minTranslate()>$&&(y=t.minTranslate()+$),w=t.minTranslate(),x=!0,a.allowMomentumBounce=!0):y=t.minTranslate(),r.loop&&r.centeredSlides&&(C=!0);else if(r.freeModeSticky){for(var k,E=0;E<l.length;E+=1)if(l[E]>-y){k=E;break}y=-(y=Math.abs(l[k]-y)<Math.abs(l[k-1]-y)||"next"===t.swipeDirection?l[k]:l[k-1])}if(C&&t.once("transitionEnd",function(){t.loopFix()}),0!==t.velocity)g=n?Math.abs((-y-t.translate)/t.velocity):Math.abs((y-t.translate)/t.velocity);else if(r.freeModeSticky)return void t.slideToClosest();r.freeModeMomentumBounce&&x?(t.updateProgress(w),t.setTransition(g),t.setTranslate(y),t.transitionStart(!0,t.swipeDirection),t.animating=!0,s.transitionEnd(function(){t&&!t.destroyed&&a.allowMomentumBounce&&(t.emit("momentumBounce"),t.setTransition(r.speed),t.setTranslate(w),s.transitionEnd(function(){t&&!t.destroyed&&t.transitionEnd()}))})):t.velocity?(t.updateProgress(y),t.setTransition(g),t.setTranslate(y),t.transitionStart(!0,t.swipeDirection),t.animating||(t.animating=!0,s.transitionEnd(function(){t&&!t.destroyed&&t.transitionEnd()}))):t.updateProgress(y),t.updateActiveIndex(),t.updateSlidesClasses()}else if(r.freeModeSticky)return void t.slideToClosest();(!r.freeModeMomentum||u>=r.longSwipesMs)&&(t.updateProgress(),t.updateActiveIndex(),t.updateSlidesClasses())}else{for(var S=0,T=t.slidesSizesGrid[0],M=0;M<o.length;M+=r.slidesPerGroup)void 0!==o[M+r.slidesPerGroup]?c>=o[M]&&c<o[M+r.slidesPerGroup]&&(S=M,T=o[M+r.slidesPerGroup]-o[M]):c>=o[M]&&(S=M,T=o[o.length-1]-o[o.length-2]);var P=(c-o[S])/T;if(u>r.longSwipesMs){if(!r.longSwipes)return void t.slideTo(t.activeIndex);"next"===t.swipeDirection&&(P>=r.longSwipesRatio?t.slideTo(S+r.slidesPerGroup):t.slideTo(S)),"prev"===t.swipeDirection&&(P>1-r.longSwipesRatio?t.slideTo(S+r.slidesPerGroup):t.slideTo(S))}else{if(!r.shortSwipes)return void t.slideTo(t.activeIndex);"next"===t.swipeDirection&&t.slideTo(S+r.slidesPerGroup),"prev"===t.swipeDirection&&t.slideTo(S)}}}function onResize(){var e=this.params,t=this.el;if(!t||0!==t.offsetWidth){e.breakpoints&&this.setBreakpoint();var a=this.allowSlideNext,r=this.allowSlidePrev,i=this.snapGrid;if(this.allowSlideNext=!0,this.allowSlidePrev=!0,this.updateSize(),this.updateSlides(),e.freeMode){var n=Math.min(Math.max(this.translate,this.maxTranslate()),this.minTranslate());this.setTranslate(n),this.updateActiveIndex(),this.updateSlidesClasses(),e.autoHeight&&this.updateAutoHeight()}else this.updateSlidesClasses(),("auto"===e.slidesPerView||e.slidesPerView>1)&&this.isEnd&&!this.params.centeredSlides?this.slideTo(this.slides.length-1,0,!1,!0):this.slideTo(this.activeIndex,0,!1,!0);this.allowSlidePrev=r,this.allowSlideNext=a,this.params.watchOverflow&&i!==this.snapGrid&&this.checkOverflow()}}function onClick(e){this.allowClick||(this.params.preventClicks&&e.preventDefault(),this.params.preventClicksPropagation&&this.animating&&(e.stopPropagation(),e.stopImmediatePropagation()))}function attachEvents(){var e=this.params,t=this.touchEvents,a=this.el,r=this.wrapperEl;this.onTouchStart=onTouchStart.bind(this),this.onTouchMove=onTouchMove.bind(this),this.onTouchEnd=onTouchEnd.bind(this),this.onClick=onClick.bind(this);var i="container"===e.touchEventsTarget?a:r,n=!!e.nested;if(Support.touch||!Support.pointerEvents&&!Support.prefixedPointerEvents){if(Support.touch){var s=!("touchstart"!==t.start||!Support.passiveListener||!e.passiveListeners)&&{passive:!0,capture:!1};i.addEventListener(t.start,this.onTouchStart,s),i.addEventListener(t.move,this.onTouchMove,Support.passiveListener?{passive:!1,capture:n}:n),i.addEventListener(t.end,this.onTouchEnd,s)}(e.simulateTouch&&!Device.ios&&!Device.android||e.simulateTouch&&!Support.touch&&Device.ios)&&(i.addEventListener("mousedown",this.onTouchStart,!1),doc.addEventListener("mousemove",this.onTouchMove,n),doc.addEventListener("mouseup",this.onTouchEnd,!1))}else i.addEventListener(t.start,this.onTouchStart,!1),doc.addEventListener(t.move,this.onTouchMove,n),doc.addEventListener(t.end,this.onTouchEnd,!1);(e.preventClicks||e.preventClicksPropagation)&&i.addEventListener("click",this.onClick,!0),this.on(Device.ios||Device.android?"resize orientationchange observerUpdate":"resize observerUpdate",onResize,!0)}function detachEvents(){var e=this.params,t=this.touchEvents,a=this.el,r=this.wrapperEl,i="container"===e.touchEventsTarget?a:r,n=!!e.nested;if(Support.touch||!Support.pointerEvents&&!Support.prefixedPointerEvents){if(Support.touch){var s=!("onTouchStart"!==t.start||!Support.passiveListener||!e.passiveListeners)&&{passive:!0,capture:!1};i.removeEventListener(t.start,this.onTouchStart,s),i.removeEventListener(t.move,this.onTouchMove,n),i.removeEventListener(t.end,this.onTouchEnd,s)}(e.simulateTouch&&!Device.ios&&!Device.android||e.simulateTouch&&!Support.touch&&Device.ios)&&(i.removeEventListener("mousedown",this.onTouchStart,!1),doc.removeEventListener("mousemove",this.onTouchMove,n),doc.removeEventListener("mouseup",this.onTouchEnd,!1))}else i.removeEventListener(t.start,this.onTouchStart,!1),doc.removeEventListener(t.move,this.onTouchMove,n),doc.removeEventListener(t.end,this.onTouchEnd,!1);(e.preventClicks||e.preventClicksPropagation)&&i.removeEventListener("click",this.onClick,!0),this.off(Device.ios||Device.android?"resize orientationchange observerUpdate":"resize observerUpdate",onResize)}var events={attachEvents:attachEvents,detachEvents:detachEvents};function setBreakpoint(){var e=this.activeIndex,t=this.initialized,a=this.loopedSlides;void 0===a&&(a=0);var r=this.params,i=r.breakpoints;if(i&&(!i||0!==Object.keys(i).length)){var n=this.getBreakpoint(i);if(n&&this.currentBreakpoint!==n){var s=n in i?i[n]:void 0;s&&["slidesPerView","spaceBetween","slidesPerGroup"].forEach(function(e){var t=s[e];void 0!==t&&(s[e]="slidesPerView"!==e||"AUTO"!==t&&"auto"!==t?"slidesPerView"===e?parseFloat(t):parseInt(t,10):"auto")});var o=s||this.originalParams,l=o.direction&&o.direction!==r.direction,p=r.loop&&(o.slidesPerView!==r.slidesPerView||l);l&&t&&this.changeDirection(),Utils.extend(this.params,o),Utils.extend(this,{allowTouchMove:this.params.allowTouchMove,allowSlideNext:this.params.allowSlideNext,allowSlidePrev:this.params.allowSlidePrev}),this.currentBreakpoint=n,p&&t&&(this.loopDestroy(),this.loopCreate(),this.updateSlides(),this.slideTo(e-a+this.loopedSlides,0,!1)),this.emit("breakpoint",o)}}}function getBreakpoint(e){if(e){var t=!1,a=[];Object.keys(e).forEach(function(e){a.push(e)}),a.sort(function(e,t){return parseInt(e,10)-parseInt(t,10)});for(var r=0;r<a.length;r+=1){var i=a[r];this.params.breakpointsInverse?i<=win.innerWidth&&(t=i):i>=win.innerWidth&&!t&&(t=i)}return t||"max"}}var breakpoints={setBreakpoint:setBreakpoint,getBreakpoint:getBreakpoint};function addClasses(){var e=this.classNames,t=this.params,a=this.rtl,r=this.$el,i=[];i.push("initialized"),i.push(t.direction),t.freeMode&&i.push("free-mode"),Support.flexbox||i.push("no-flexbox"),t.autoHeight&&i.push("autoheight"),a&&i.push("rtl"),t.slidesPerColumn>1&&i.push("multirow"),Device.android&&i.push("android"),Device.ios&&i.push("ios"),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&i.push("wp8-"+t.direction),i.forEach(function(a){e.push(t.containerModifierClass+a)}),r.addClass(e.join(" "))}function removeClasses(){var e=this.$el,t=this.classNames;e.removeClass(t.join(" "))}var classes={addClasses:addClasses,removeClasses:removeClasses};function loadImage(e,t,a,r,i,n){var s;function o(){n&&n()}e.complete&&i?o():t?((s=new win.Image).onload=o,s.onerror=o,r&&(s.sizes=r),a&&(s.srcset=a),t&&(s.src=t)):o()}function preloadImages(){var e=this;function t(){null!=e&&e&&!e.destroyed&&(void 0!==e.imagesLoaded&&(e.imagesLoaded+=1),e.imagesLoaded===e.imagesToLoad.length&&(e.params.updateOnImagesReady&&e.update(),e.emit("imagesReady")))}e.imagesToLoad=e.$el.find("img");for(var a=0;a<e.imagesToLoad.length;a+=1){var r=e.imagesToLoad[a];e.loadImage(r,r.currentSrc||r.getAttribute("src"),r.srcset||r.getAttribute("srcset"),r.sizes||r.getAttribute("sizes"),!0,t)}}var images={loadImage:loadImage,preloadImages:preloadImages};function checkOverflow(){var e=this.isLocked;this.isLocked=1===this.snapGrid.length,this.allowSlideNext=!this.isLocked,this.allowSlidePrev=!this.isLocked,e!==this.isLocked&&this.emit(this.isLocked?"lock":"unlock"),e&&e!==this.isLocked&&(this.isEnd=!1,this.navigation.update())}var checkOverflow$1={checkOverflow:checkOverflow},defaults={init:!0,direction:"horizontal",touchEventsTarget:"container",initialSlide:0,speed:300,preventInteractionOnTransition:!1,edgeSwipeDetection:!1,edgeSwipeThreshold:20,freeMode:!1,freeModeMomentum:!0,freeModeMomentumRatio:1,freeModeMomentumBounce:!0,freeModeMomentumBounceRatio:1,freeModeMomentumVelocityRatio:1,freeModeSticky:!1,freeModeMinimumVelocity:.02,autoHeight:!1,setWrapperSize:!1,virtualTranslate:!1,effect:"slide",breakpoints:void 0,breakpointsInverse:!1,spaceBetween:0,slidesPerView:1,slidesPerColumn:1,slidesPerColumnFill:"column",slidesPerGroup:1,centeredSlides:!1,slidesOffsetBefore:0,slidesOffsetAfter:0,normalizeSlideIndex:!0,centerInsufficientSlides:!1,watchOverflow:!1,roundLengths:!1,touchRatio:1,touchAngle:45,simulateTouch:!0,shortSwipes:!0,longSwipes:!0,longSwipesRatio:.5,longSwipesMs:300,followFinger:!0,allowTouchMove:!0,threshold:0,touchMoveStopPropagation:!0,touchStartPreventDefault:!0,touchStartForcePreventDefault:!1,touchReleaseOnEdges:!1,uniqueNavElements:!0,resistance:!0,resistanceRatio:.85,watchSlidesProgress:!1,watchSlidesVisibility:!1,grabCursor:!1,preventClicks:!0,preventClicksPropagation:!0,slideToClickedSlide:!1,preloadImages:!0,updateOnImagesReady:!0,loop:!1,loopAdditionalSlides:0,loopedSlides:null,loopFillGroupWithBlank:!1,allowSlidePrev:!0,allowSlideNext:!0,swipeHandler:null,noSwiping:!0,noSwipingClass:"swiper-no-swiping",noSwipingSelector:null,passiveListeners:!0,containerModifierClass:"swiper-container-",slideClass:"swiper-slide",slideBlankClass:"swiper-slide-invisible-blank",slideActiveClass:"swiper-slide-active",slideDuplicateActiveClass:"swiper-slide-duplicate-active",slideVisibleClass:"swiper-slide-visible",slideDuplicateClass:"swiper-slide-duplicate",slideNextClass:"swiper-slide-next",slideDuplicateNextClass:"swiper-slide-duplicate-next",slidePrevClass:"swiper-slide-prev",slideDuplicatePrevClass:"swiper-slide-duplicate-prev",wrapperClass:"swiper-wrapper",runCallbacksOnInit:!0},prototypes={update:update,translate:translate,transition:transition$1,slide:slide,loop:loop,grabCursor:grabCursor,manipulation:manipulation,events:events,breakpoints:breakpoints,checkOverflow:checkOverflow$1,classes:classes,images:images},extendedDefaults={},Swiper=function(e){function t(){for(var a,r,i,n=[],s=arguments.length;s--;)n[s]=arguments[s];1===n.length&&n[0].constructor&&n[0].constructor===Object?i=n[0]:(r=(a=n)[0],i=a[1]),i||(i={}),i=Utils.extend({},i),r&&!i.el&&(i.el=r),e.call(this,i),Object.keys(prototypes).forEach(function(e){Object.keys(prototypes[e]).forEach(function(a){t.prototype[a]||(t.prototype[a]=prototypes[e][a])})});var o=this;void 0===o.modules&&(o.modules={}),Object.keys(o.modules).forEach(function(e){var t=o.modules[e];if(t.params){var a=Object.keys(t.params)[0],r=t.params[a];if("object"!=typeof r||null===r)return;if(!(a in i&&"enabled"in r))return;!0===i[a]&&(i[a]={enabled:!0}),"object"!=typeof i[a]||"enabled"in i[a]||(i[a].enabled=!0),i[a]||(i[a]={enabled:!1})}});var l=Utils.extend({},defaults);o.useModulesParams(l),o.params=Utils.extend({},l,extendedDefaults,i),o.originalParams=Utils.extend({},o.params),o.passedParams=Utils.extend({},i),o.$=$;var p=$(o.params.el);if(r=p[0]){if(p.length>1){var c=[];return p.each(function(e,a){var r=Utils.extend({},i,{el:a});c.push(new t(r))}),c}r.swiper=o,p.data("swiper",o);var d,u,h=p.children("."+o.params.wrapperClass);return Utils.extend(o,{$el:p,el:r,$wrapperEl:h,wrapperEl:h[0],classNames:[],slides:$(),slidesGrid:[],snapGrid:[],slidesSizesGrid:[],isHorizontal:function(){return"horizontal"===o.params.direction},isVertical:function(){return"vertical"===o.params.direction},rtl:"rtl"===r.dir.toLowerCase()||"rtl"===p.css("direction"),rtlTranslate:"horizontal"===o.params.direction&&("rtl"===r.dir.toLowerCase()||"rtl"===p.css("direction")),wrongRTL:"-webkit-box"===h.css("display"),activeIndex:0,realIndex:0,isBeginning:!0,isEnd:!1,translate:0,previousTranslate:0,progress:0,velocity:0,animating:!1,allowSlideNext:o.params.allowSlideNext,allowSlidePrev:o.params.allowSlidePrev,touchEvents:(d=["touchstart","touchmove","touchend"],u=["mousedown","mousemove","mouseup"],Support.pointerEvents?u=["pointerdown","pointermove","pointerup"]:Support.prefixedPointerEvents&&(u=["MSPointerDown","MSPointerMove","MSPointerUp"]),o.touchEventsTouch={start:d[0],move:d[1],end:d[2]},o.touchEventsDesktop={start:u[0],move:u[1],end:u[2]},Support.touch||!o.params.simulateTouch?o.touchEventsTouch:o.touchEventsDesktop),touchEventsData:{isTouched:void 0,isMoved:void 0,allowTouchCallbacks:void 0,touchStartTime:void 0,isScrolling:void 0,currentTranslate:void 0,startTranslate:void 0,allowThresholdMove:void 0,formElements:"input, select, option, textarea, button, video",lastClickTime:Utils.now(),clickTimeout:void 0,velocities:[],allowMomentumBounce:void 0,isTouchEvent:void 0,startMoving:void 0},allowClick:!0,allowTouchMove:o.params.allowTouchMove,touches:{startX:0,startY:0,currentX:0,currentY:0,diff:0},imagesToLoad:[],imagesLoaded:0}),o.useModules(),o.params.init&&o.init(),o}}e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t;var a={extendedDefaults:{configurable:!0},defaults:{configurable:!0},Class:{configurable:!0},$:{configurable:!0}};return t.prototype.slidesPerViewDynamic=function(){var e=this.params,t=this.slides,a=this.slidesGrid,r=this.size,i=this.activeIndex,n=1;if(e.centeredSlides){for(var s,o=t[i].swiperSlideSize,l=i+1;l<t.length;l+=1)t[l]&&!s&&(n+=1,(o+=t[l].swiperSlideSize)>r&&(s=!0));for(var p=i-1;p>=0;p-=1)t[p]&&!s&&(n+=1,(o+=t[p].swiperSlideSize)>r&&(s=!0))}else for(var c=i+1;c<t.length;c+=1)a[c]-a[i]<r&&(n+=1);return n},t.prototype.update=function(){var e=this;if(e&&!e.destroyed){var t=e.snapGrid,a=e.params;a.breakpoints&&e.setBreakpoint(),e.updateSize(),e.updateSlides(),e.updateProgress(),e.updateSlidesClasses(),e.params.freeMode?(r(),e.params.autoHeight&&e.updateAutoHeight()):(("auto"===e.params.slidesPerView||e.params.slidesPerView>1)&&e.isEnd&&!e.params.centeredSlides?e.slideTo(e.slides.length-1,0,!1,!0):e.slideTo(e.activeIndex,0,!1,!0))||r(),a.watchOverflow&&t!==e.snapGrid&&e.checkOverflow(),e.emit("update")}function r(){var t=e.rtlTranslate?-1*e.translate:e.translate,a=Math.min(Math.max(t,e.maxTranslate()),e.minTranslate());e.setTranslate(a),e.updateActiveIndex(),e.updateSlidesClasses()}},t.prototype.changeDirection=function(e,t){void 0===t&&(t=!0);var a=this.params.direction;return e||(e="horizontal"===a?"vertical":"horizontal"),e===a||"horizontal"!==e&&"vertical"!==e?this:("vertical"===a&&(this.$el.removeClass(this.params.containerModifierClass+"vertical wp8-vertical").addClass(""+this.params.containerModifierClass+e),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&this.$el.addClass(this.params.containerModifierClass+"wp8-"+e)),"horizontal"===a&&(this.$el.removeClass(this.params.containerModifierClass+"horizontal wp8-horizontal").addClass(""+this.params.containerModifierClass+e),(Browser.isIE||Browser.isEdge)&&(Support.pointerEvents||Support.prefixedPointerEvents)&&this.$el.addClass(this.params.containerModifierClass+"wp8-"+e)),this.params.direction=e,this.slides.each(function(t,a){"vertical"===e?a.style.width="":a.style.height=""}),this.emit("changeDirection"),t&&this.update(),this)},t.prototype.init=function(){this.initialized||(this.emit("beforeInit"),this.params.breakpoints&&this.setBreakpoint(),this.addClasses(),this.params.loop&&this.loopCreate(),this.updateSize(),this.updateSlides(),this.params.watchOverflow&&this.checkOverflow(),this.params.grabCursor&&this.setGrabCursor(),this.params.preloadImages&&this.preloadImages(),this.params.loop?this.slideTo(this.params.initialSlide+this.loopedSlides,0,this.params.runCallbacksOnInit):this.slideTo(this.params.initialSlide,0,this.params.runCallbacksOnInit),this.attachEvents(),this.initialized=!0,this.emit("init"))},t.prototype.destroy=function(e,t){void 0===e&&(e=!0),void 0===t&&(t=!0);var a=this,r=a.params,i=a.$el,n=a.$wrapperEl,s=a.slides;return void 0===a.params||a.destroyed?null:(a.emit("beforeDestroy"),a.initialized=!1,a.detachEvents(),r.loop&&a.loopDestroy(),t&&(a.removeClasses(),i.removeAttr("style"),n.removeAttr("style"),s&&s.length&&s.removeClass([r.slideVisibleClass,r.slideActiveClass,r.slideNextClass,r.slidePrevClass].join(" ")).removeAttr("style").removeAttr("data-swiper-slide-index").removeAttr("data-swiper-column").removeAttr("data-swiper-row")),a.emit("destroy"),Object.keys(a.eventsListeners).forEach(function(e){a.off(e)}),!1!==e&&(a.$el[0].swiper=null,a.$el.data("swiper",null),Utils.deleteProps(a)),a.destroyed=!0,null)},t.extendDefaults=function(e){Utils.extend(extendedDefaults,e)},a.extendedDefaults.get=function(){return extendedDefaults},a.defaults.get=function(){return defaults},a.Class.get=function(){return e},a.$.get=function(){return $},Object.defineProperties(t,a),t}(Framework7Class),Device$1={name:"device",proto:{device:Device},static:{device:Device}},Support$1={name:"support",proto:{support:Support},static:{support:Support}},Browser$1={name:"browser",proto:{browser:Browser},static:{browser:Browser}},Resize={name:"resize",create:function(){var e=this;Utils.extend(e,{resize:{resizeHandler:function(){e&&!e.destroyed&&e.initialized&&(e.emit("beforeResize"),e.emit("resize"))},orientationChangeHandler:function(){e&&!e.destroyed&&e.initialized&&e.emit("orientationchange")}}})},on:{init:function(){win.addEventListener("resize",this.resize.resizeHandler),win.addEventListener("orientationchange",this.resize.orientationChangeHandler)},destroy:function(){win.removeEventListener("resize",this.resize.resizeHandler),win.removeEventListener("orientationchange",this.resize.orientationChangeHandler)}}},Observer={func:win.MutationObserver||win.WebkitMutationObserver,attach:function(e,t){void 0===t&&(t={});var a=this,r=new(0,Observer.func)(function(e){if(1!==e.length){var t=function(){a.emit("observerUpdate",e[0])};win.requestAnimationFrame?win.requestAnimationFrame(t):win.setTimeout(t,0)}else a.emit("observerUpdate",e[0])});r.observe(e,{attributes:void 0===t.attributes||t.attributes,childList:void 0===t.childList||t.childList,characterData:void 0===t.characterData||t.characterData}),a.observer.observers.push(r)},init:function(){if(Support.observer&&this.params.observer){if(this.params.observeParents)for(var e=this.$el.parents(),t=0;t<e.length;t+=1)this.observer.attach(e[t]);this.observer.attach(this.$el[0],{childList:this.params.observeSlideChildren}),this.observer.attach(this.$wrapperEl[0],{attributes:!1})}},destroy:function(){this.observer.observers.forEach(function(e){e.disconnect()}),this.observer.observers=[]}},Observer$1={name:"observer",params:{observer:!1,observeParents:!1,observeSlideChildren:!1},create:function(){Utils.extend(this,{observer:{init:Observer.init.bind(this),attach:Observer.attach.bind(this),destroy:Observer.destroy.bind(this),observers:[]}})},on:{init:function(){this.observer.init()},destroy:function(){this.observer.destroy()}}},Virtual={update:function(e){var t=this,a=t.params,r=a.slidesPerView,i=a.slidesPerGroup,n=a.centeredSlides,s=t.params.virtual,o=s.addSlidesBefore,l=s.addSlidesAfter,p=t.virtual,c=p.from,d=p.to,u=p.slides,h=p.slidesGrid,f=p.renderSlide,v=p.offset;t.updateActiveIndex();var m,g,b,y=t.activeIndex||0;m=t.rtlTranslate?"right":t.isHorizontal()?"left":"top",n?(g=Math.floor(r/2)+i+o,b=Math.floor(r/2)+i+l):(g=r+(i-1)+o,b=i+l);var w=Math.max((y||0)-b,0),C=Math.min((y||0)+g,u.length-1),x=(t.slidesGrid[w]||0)-(t.slidesGrid[0]||0);function $(){t.updateSlides(),t.updateProgress(),t.updateSlidesClasses(),t.lazy&&t.params.lazy.enabled&&t.lazy.load()}if(Utils.extend(t.virtual,{from:w,to:C,offset:x,slidesGrid:t.slidesGrid}),c===w&&d===C&&!e)return t.slidesGrid!==h&&x!==v&&t.slides.css(m,x+"px"),void t.updateProgress();if(t.params.virtual.renderExternal)return t.params.virtual.renderExternal.call(t,{offset:x,from:w,to:C,slides:function(){for(var e=[],t=w;t<=C;t+=1)e.push(u[t]);return e}()}),void $();var k=[],E=[];if(e)t.$wrapperEl.find("."+t.params.slideClass).remove();else for(var S=c;S<=d;S+=1)(S<w||S>C)&&t.$wrapperEl.find("."+t.params.slideClass+'[data-swiper-slide-index="'+S+'"]').remove();for(var T=0;T<u.length;T+=1)T>=w&&T<=C&&(void 0===d||e?E.push(T):(T>d&&E.push(T),T<c&&k.push(T)));E.forEach(function(e){t.$wrapperEl.append(f(u[e],e))}),k.sort(function(e,t){return t-e}).forEach(function(e){t.$wrapperEl.prepend(f(u[e],e))}),t.$wrapperEl.children(".swiper-slide").css(m,x+"px"),$()},renderSlide:function(e,t){var a=this.params.virtual;if(a.cache&&this.virtual.cache[t])return this.virtual.cache[t];var r=a.renderSlide?$(a.renderSlide.call(this,e,t)):$('<div class="'+this.params.slideClass+'" data-swiper-slide-index="'+t+'">'+e+"</div>");return r.attr("data-swiper-slide-index")||r.attr("data-swiper-slide-index",t),a.cache&&(this.virtual.cache[t]=r),r},appendSlide:function(e){if("object"==typeof e&&"length"in e)for(var t=0;t<e.length;t+=1)e[t]&&this.virtual.slides.push(e[t]);else this.virtual.slides.push(e);this.virtual.update(!0)},prependSlide:function(e){var t=this.activeIndex,a=t+1,r=1;if(Array.isArray(e)){for(var i=0;i<e.length;i+=1)e[i]&&this.virtual.slides.unshift(e[i]);a=t+e.length,r=e.length}else this.virtual.slides.unshift(e);if(this.params.virtual.cache){var n=this.virtual.cache,s={};Object.keys(n).forEach(function(e){s[parseInt(e,10)+r]=n[e]}),this.virtual.cache=s}this.virtual.update(!0),this.slideTo(a,0)},removeSlide:function(e){if(null!=e){var t=this.activeIndex;if(Array.isArray(e))for(var a=e.length-1;a>=0;a-=1)this.virtual.slides.splice(e[a],1),this.params.virtual.cache&&delete this.virtual.cache[e[a]],e[a]<t&&(t-=1),t=Math.max(t,0);else this.virtual.slides.splice(e,1),this.params.virtual.cache&&delete this.virtual.cache[e],e<t&&(t-=1),t=Math.max(t,0);this.virtual.update(!0),this.slideTo(t,0)}},removeAllSlides:function(){this.virtual.slides=[],this.params.virtual.cache&&(this.virtual.cache={}),this.virtual.update(!0),this.slideTo(0,0)}},Virtual$1={name:"virtual",params:{virtual:{enabled:!1,slides:[],cache:!0,renderSlide:null,renderExternal:null,addSlidesBefore:0,addSlidesAfter:0}},create:function(){Utils.extend(this,{virtual:{update:Virtual.update.bind(this),appendSlide:Virtual.appendSlide.bind(this),prependSlide:Virtual.prependSlide.bind(this),removeSlide:Virtual.removeSlide.bind(this),removeAllSlides:Virtual.removeAllSlides.bind(this),renderSlide:Virtual.renderSlide.bind(this),slides:this.params.virtual.slides,cache:{}}})},on:{beforeInit:function(){if(this.params.virtual.enabled){this.classNames.push(this.params.containerModifierClass+"virtual");var e={watchSlidesProgress:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e),this.params.initialSlide||this.virtual.update()}},setTranslate:function(){this.params.virtual.enabled&&this.virtual.update()}}},Navigation={update:function(){var e=this.params.navigation;if(!this.params.loop){var t=this.navigation,a=t.$nextEl,r=t.$prevEl;r&&r.length>0&&(this.isBeginning?r.addClass(e.disabledClass):r.removeClass(e.disabledClass),r[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](e.lockClass)),a&&a.length>0&&(this.isEnd?a.addClass(e.disabledClass):a.removeClass(e.disabledClass),a[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](e.lockClass))}},onPrevClick:function(e){e.preventDefault(),this.isBeginning&&!this.params.loop||this.slidePrev()},onNextClick:function(e){e.preventDefault(),this.isEnd&&!this.params.loop||this.slideNext()},init:function(){var e,t,a=this.params.navigation;(a.nextEl||a.prevEl)&&(a.nextEl&&(e=$(a.nextEl),this.params.uniqueNavElements&&"string"==typeof a.nextEl&&e.length>1&&1===this.$el.find(a.nextEl).length&&(e=this.$el.find(a.nextEl))),a.prevEl&&(t=$(a.prevEl),this.params.uniqueNavElements&&"string"==typeof a.prevEl&&t.length>1&&1===this.$el.find(a.prevEl).length&&(t=this.$el.find(a.prevEl))),e&&e.length>0&&e.on("click",this.navigation.onNextClick),t&&t.length>0&&t.on("click",this.navigation.onPrevClick),Utils.extend(this.navigation,{$nextEl:e,nextEl:e&&e[0],$prevEl:t,prevEl:t&&t[0]}))},destroy:function(){var e=this.navigation,t=e.$nextEl,a=e.$prevEl;t&&t.length&&(t.off("click",this.navigation.onNextClick),t.removeClass(this.params.navigation.disabledClass)),a&&a.length&&(a.off("click",this.navigation.onPrevClick),a.removeClass(this.params.navigation.disabledClass))}},Navigation$1={name:"navigation",params:{navigation:{nextEl:null,prevEl:null,hideOnClick:!1,disabledClass:"swiper-button-disabled",hiddenClass:"swiper-button-hidden",lockClass:"swiper-button-lock"}},create:function(){Utils.extend(this,{navigation:{init:Navigation.init.bind(this),update:Navigation.update.bind(this),destroy:Navigation.destroy.bind(this),onNextClick:Navigation.onNextClick.bind(this),onPrevClick:Navigation.onPrevClick.bind(this)}})},on:{init:function(){this.navigation.init(),this.navigation.update()},toEdge:function(){this.navigation.update()},fromEdge:function(){this.navigation.update()},destroy:function(){this.navigation.destroy()},click:function(e){var t,a=this.navigation,r=a.$nextEl,i=a.$prevEl;!this.params.navigation.hideOnClick||$(e.target).is(i)||$(e.target).is(r)||(r?t=r.hasClass(this.params.navigation.hiddenClass):i&&(t=i.hasClass(this.params.navigation.hiddenClass)),!0===t?this.emit("navigationShow",this):this.emit("navigationHide",this),r&&r.toggleClass(this.params.navigation.hiddenClass),i&&i.toggleClass(this.params.navigation.hiddenClass))}}},Pagination={update:function(){var e=this.rtl,t=this.params.pagination;if(t.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var a,r=this.virtual&&this.params.virtual.enabled?this.virtual.slides.length:this.slides.length,i=this.pagination.$el,n=this.params.loop?Math.ceil((r-2*this.loopedSlides)/this.params.slidesPerGroup):this.snapGrid.length;if(this.params.loop?((a=Math.ceil((this.activeIndex-this.loopedSlides)/this.params.slidesPerGroup))>r-1-2*this.loopedSlides&&(a-=r-2*this.loopedSlides),a>n-1&&(a-=n),a<0&&"bullets"!==this.params.paginationType&&(a=n+a)):a=void 0!==this.snapIndex?this.snapIndex:this.activeIndex||0,"bullets"===t.type&&this.pagination.bullets&&this.pagination.bullets.length>0){var s,o,l,p=this.pagination.bullets;if(t.dynamicBullets&&(this.pagination.bulletSize=p.eq(0)[this.isHorizontal()?"outerWidth":"outerHeight"](!0),i.css(this.isHorizontal()?"width":"height",this.pagination.bulletSize*(t.dynamicMainBullets+4)+"px"),t.dynamicMainBullets>1&&void 0!==this.previousIndex&&(this.pagination.dynamicBulletIndex+=a-this.previousIndex,this.pagination.dynamicBulletIndex>t.dynamicMainBullets-1?this.pagination.dynamicBulletIndex=t.dynamicMainBullets-1:this.pagination.dynamicBulletIndex<0&&(this.pagination.dynamicBulletIndex=0)),s=a-this.pagination.dynamicBulletIndex,l=((o=s+(Math.min(p.length,t.dynamicMainBullets)-1))+s)/2),p.removeClass(t.bulletActiveClass+" "+t.bulletActiveClass+"-next "+t.bulletActiveClass+"-next-next "+t.bulletActiveClass+"-prev "+t.bulletActiveClass+"-prev-prev "+t.bulletActiveClass+"-main"),i.length>1)p.each(function(e,r){var i=$(r),n=i.index();n===a&&i.addClass(t.bulletActiveClass),t.dynamicBullets&&(n>=s&&n<=o&&i.addClass(t.bulletActiveClass+"-main"),n===s&&i.prev().addClass(t.bulletActiveClass+"-prev").prev().addClass(t.bulletActiveClass+"-prev-prev"),n===o&&i.next().addClass(t.bulletActiveClass+"-next").next().addClass(t.bulletActiveClass+"-next-next"))});else if(p.eq(a).addClass(t.bulletActiveClass),t.dynamicBullets){for(var c=p.eq(s),d=p.eq(o),u=s;u<=o;u+=1)p.eq(u).addClass(t.bulletActiveClass+"-main");c.prev().addClass(t.bulletActiveClass+"-prev").prev().addClass(t.bulletActiveClass+"-prev-prev"),d.next().addClass(t.bulletActiveClass+"-next").next().addClass(t.bulletActiveClass+"-next-next")}if(t.dynamicBullets){var h=Math.min(p.length,t.dynamicMainBullets+4),f=(this.pagination.bulletSize*h-this.pagination.bulletSize)/2-l*this.pagination.bulletSize,v=e?"right":"left";p.css(this.isHorizontal()?v:"top",f+"px")}}if("fraction"===t.type&&(i.find("."+t.currentClass).text(t.formatFractionCurrent(a+1)),i.find("."+t.totalClass).text(t.formatFractionTotal(n))),"progressbar"===t.type){var m;m=t.progressbarOpposite?this.isHorizontal()?"vertical":"horizontal":this.isHorizontal()?"horizontal":"vertical";var g=(a+1)/n,b=1,y=1;"horizontal"===m?b=g:y=g,i.find("."+t.progressbarFillClass).transform("translate3d(0,0,0) scaleX("+b+") scaleY("+y+")").transition(this.params.speed)}"custom"===t.type&&t.renderCustom?(i.html(t.renderCustom(this,a+1,n)),this.emit("paginationRender",this,i[0])):this.emit("paginationUpdate",this,i[0]),i[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](t.lockClass)}},render:function(){var e=this.params.pagination;if(e.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var t=this.virtual&&this.params.virtual.enabled?this.virtual.slides.length:this.slides.length,a=this.pagination.$el,r="";if("bullets"===e.type){for(var i=this.params.loop?Math.ceil((t-2*this.loopedSlides)/this.params.slidesPerGroup):this.snapGrid.length,n=0;n<i;n+=1)e.renderBullet?r+=e.renderBullet.call(this,n,e.bulletClass):r+="<"+e.bulletElement+' class="'+e.bulletClass+'"></'+e.bulletElement+">";a.html(r),this.pagination.bullets=a.find("."+e.bulletClass)}"fraction"===e.type&&(r=e.renderFraction?e.renderFraction.call(this,e.currentClass,e.totalClass):'<span class="'+e.currentClass+'"></span> / <span class="'+e.totalClass+'"></span>',a.html(r)),"progressbar"===e.type&&(r=e.renderProgressbar?e.renderProgressbar.call(this,e.progressbarFillClass):'<span class="'+e.progressbarFillClass+'"></span>',a.html(r)),"custom"!==e.type&&this.emit("paginationRender",this.pagination.$el[0])}},init:function(){var e=this,t=e.params.pagination;if(t.el){var a=$(t.el);0!==a.length&&(e.params.uniqueNavElements&&"string"==typeof t.el&&a.length>1&&1===e.$el.find(t.el).length&&(a=e.$el.find(t.el)),"bullets"===t.type&&t.clickable&&a.addClass(t.clickableClass),a.addClass(t.modifierClass+t.type),"bullets"===t.type&&t.dynamicBullets&&(a.addClass(""+t.modifierClass+t.type+"-dynamic"),e.pagination.dynamicBulletIndex=0,t.dynamicMainBullets<1&&(t.dynamicMainBullets=1)),"progressbar"===t.type&&t.progressbarOpposite&&a.addClass(t.progressbarOppositeClass),t.clickable&&a.on("click","."+t.bulletClass,function(t){t.preventDefault();var a=$(this).index()*e.params.slidesPerGroup;e.params.loop&&(a+=e.loopedSlides),e.slideTo(a)}),Utils.extend(e.pagination,{$el:a,el:a[0]}))}},destroy:function(){var e=this.params.pagination;if(e.el&&this.pagination.el&&this.pagination.$el&&0!==this.pagination.$el.length){var t=this.pagination.$el;t.removeClass(e.hiddenClass),t.removeClass(e.modifierClass+e.type),this.pagination.bullets&&this.pagination.bullets.removeClass(e.bulletActiveClass),e.clickable&&t.off("click","."+e.bulletClass)}}},Pagination$1={name:"pagination",params:{pagination:{el:null,bulletElement:"span",clickable:!1,hideOnClick:!1,renderBullet:null,renderProgressbar:null,renderFraction:null,renderCustom:null,progressbarOpposite:!1,type:"bullets",dynamicBullets:!1,dynamicMainBullets:1,formatFractionCurrent:function(e){return e},formatFractionTotal:function(e){return e},bulletClass:"swiper-pagination-bullet",bulletActiveClass:"swiper-pagination-bullet-active",modifierClass:"swiper-pagination-",currentClass:"swiper-pagination-current",totalClass:"swiper-pagination-total",hiddenClass:"swiper-pagination-hidden",progressbarFillClass:"swiper-pagination-progressbar-fill",progressbarOppositeClass:"swiper-pagination-progressbar-opposite",clickableClass:"swiper-pagination-clickable",lockClass:"swiper-pagination-lock"}},create:function(){Utils.extend(this,{pagination:{init:Pagination.init.bind(this),render:Pagination.render.bind(this),update:Pagination.update.bind(this),destroy:Pagination.destroy.bind(this),dynamicBulletIndex:0}})},on:{init:function(){this.pagination.init(),this.pagination.render(),this.pagination.update()},activeIndexChange:function(){this.params.loop?this.pagination.update():void 0===this.snapIndex&&this.pagination.update()},snapIndexChange:function(){this.params.loop||this.pagination.update()},slidesLengthChange:function(){this.params.loop&&(this.pagination.render(),this.pagination.update())},snapGridLengthChange:function(){this.params.loop||(this.pagination.render(),this.pagination.update())},destroy:function(){this.pagination.destroy()},click:function(e){this.params.pagination.el&&this.params.pagination.hideOnClick&&this.pagination.$el.length>0&&!$(e.target).hasClass(this.params.pagination.bulletClass)&&(!0===this.pagination.$el.hasClass(this.params.pagination.hiddenClass)?this.emit("paginationShow",this):this.emit("paginationHide",this),this.pagination.$el.toggleClass(this.params.pagination.hiddenClass))}}},Scrollbar={setTranslate:function(){if(this.params.scrollbar.el&&this.scrollbar.el){var e=this.scrollbar,t=this.rtlTranslate,a=this.progress,r=e.dragSize,i=e.trackSize,n=e.$dragEl,s=e.$el,o=this.params.scrollbar,l=r,p=(i-r)*a;t?(p=-p)>0?(l=r-p,p=0):-p+r>i&&(l=i+p):p<0?(l=r+p,p=0):p+r>i&&(l=i-p),this.isHorizontal()?(Support.transforms3d?n.transform("translate3d("+p+"px, 0, 0)"):n.transform("translateX("+p+"px)"),n[0].style.width=l+"px"):(Support.transforms3d?n.transform("translate3d(0px, "+p+"px, 0)"):n.transform("translateY("+p+"px)"),n[0].style.height=l+"px"),o.hide&&(clearTimeout(this.scrollbar.timeout),s[0].style.opacity=1,this.scrollbar.timeout=setTimeout(function(){s[0].style.opacity=0,s.transition(400)},1e3))}},setTransition:function(e){this.params.scrollbar.el&&this.scrollbar.el&&this.scrollbar.$dragEl.transition(e)},updateSize:function(){if(this.params.scrollbar.el&&this.scrollbar.el){var e=this.scrollbar,t=e.$dragEl,a=e.$el;t[0].style.width="",t[0].style.height="";var r,i=this.isHorizontal()?a[0].offsetWidth:a[0].offsetHeight,n=this.size/this.virtualSize,s=n*(i/this.size);r="auto"===this.params.scrollbar.dragSize?i*n:parseInt(this.params.scrollbar.dragSize,10),this.isHorizontal()?t[0].style.width=r+"px":t[0].style.height=r+"px",a[0].style.display=n>=1?"none":"",this.params.scrollbar.hide&&(a[0].style.opacity=0),Utils.extend(e,{trackSize:i,divider:n,moveDivider:s,dragSize:r}),e.$el[this.params.watchOverflow&&this.isLocked?"addClass":"removeClass"](this.params.scrollbar.lockClass)}},setDragPosition:function(e){var t,a=this.scrollbar,r=this.rtlTranslate,i=a.$el,n=a.dragSize,s=a.trackSize;t=((this.isHorizontal()?"touchstart"===e.type||"touchmove"===e.type?e.targetTouches[0].pageX:e.pageX||e.clientX:"touchstart"===e.type||"touchmove"===e.type?e.targetTouches[0].pageY:e.pageY||e.clientY)-i.offset()[this.isHorizontal()?"left":"top"]-n/2)/(s-n),t=Math.max(Math.min(t,1),0),r&&(t=1-t);var o=this.minTranslate()+(this.maxTranslate()-this.minTranslate())*t;this.updateProgress(o),this.setTranslate(o),this.updateActiveIndex(),this.updateSlidesClasses()},onDragStart:function(e){var t=this.params.scrollbar,a=this.scrollbar,r=this.$wrapperEl,i=a.$el,n=a.$dragEl;this.scrollbar.isTouched=!0,e.preventDefault(),e.stopPropagation(),r.transition(100),n.transition(100),a.setDragPosition(e),clearTimeout(this.scrollbar.dragTimeout),i.transition(0),t.hide&&i.css("opacity",1),this.emit("scrollbarDragStart",e)},onDragMove:function(e){var t=this.scrollbar,a=this.$wrapperEl,r=t.$el,i=t.$dragEl;this.scrollbar.isTouched&&(e.preventDefault?e.preventDefault():e.returnValue=!1,t.setDragPosition(e),a.transition(0),r.transition(0),i.transition(0),this.emit("scrollbarDragMove",e))},onDragEnd:function(e){var t=this.params.scrollbar,a=this.scrollbar.$el;this.scrollbar.isTouched&&(this.scrollbar.isTouched=!1,t.hide&&(clearTimeout(this.scrollbar.dragTimeout),this.scrollbar.dragTimeout=Utils.nextTick(function(){a.css("opacity",0),a.transition(400)},1e3)),this.emit("scrollbarDragEnd",e),t.snapOnRelease&&this.slideToClosest())},enableDraggable:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.touchEventsTouch,a=this.touchEventsDesktop,r=this.params,i=e.$el[0],n=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!1,capture:!1},s=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!0,capture:!1};Support.touch?(i.addEventListener(t.start,this.scrollbar.onDragStart,n),i.addEventListener(t.move,this.scrollbar.onDragMove,n),i.addEventListener(t.end,this.scrollbar.onDragEnd,s)):(i.addEventListener(a.start,this.scrollbar.onDragStart,n),doc.addEventListener(a.move,this.scrollbar.onDragMove,n),doc.addEventListener(a.end,this.scrollbar.onDragEnd,s))}},disableDraggable:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.touchEventsTouch,a=this.touchEventsDesktop,r=this.params,i=e.$el[0],n=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!1,capture:!1},s=!(!Support.passiveListener||!r.passiveListeners)&&{passive:!0,capture:!1};Support.touch?(i.removeEventListener(t.start,this.scrollbar.onDragStart,n),i.removeEventListener(t.move,this.scrollbar.onDragMove,n),i.removeEventListener(t.end,this.scrollbar.onDragEnd,s)):(i.removeEventListener(a.start,this.scrollbar.onDragStart,n),doc.removeEventListener(a.move,this.scrollbar.onDragMove,n),doc.removeEventListener(a.end,this.scrollbar.onDragEnd,s))}},init:function(){if(this.params.scrollbar.el){var e=this.scrollbar,t=this.$el,a=this.params.scrollbar,r=$(a.el);this.params.uniqueNavElements&&"string"==typeof a.el&&r.length>1&&1===t.find(a.el).length&&(r=t.find(a.el));var i=r.find("."+this.params.scrollbar.dragClass);0===i.length&&(i=$('<div class="'+this.params.scrollbar.dragClass+'"></div>'),r.append(i)),Utils.extend(e,{$el:r,el:r[0],$dragEl:i,dragEl:i[0]}),a.draggable&&e.enableDraggable()}},destroy:function(){this.scrollbar.disableDraggable()}},Scrollbar$1={name:"scrollbar",params:{scrollbar:{el:null,dragSize:"auto",hide:!1,draggable:!1,snapOnRelease:!0,lockClass:"swiper-scrollbar-lock",dragClass:"swiper-scrollbar-drag"}},create:function(){Utils.extend(this,{scrollbar:{init:Scrollbar.init.bind(this),destroy:Scrollbar.destroy.bind(this),updateSize:Scrollbar.updateSize.bind(this),setTranslate:Scrollbar.setTranslate.bind(this),setTransition:Scrollbar.setTransition.bind(this),enableDraggable:Scrollbar.enableDraggable.bind(this),disableDraggable:Scrollbar.disableDraggable.bind(this),setDragPosition:Scrollbar.setDragPosition.bind(this),onDragStart:Scrollbar.onDragStart.bind(this),onDragMove:Scrollbar.onDragMove.bind(this),onDragEnd:Scrollbar.onDragEnd.bind(this),isTouched:!1,timeout:null,dragTimeout:null}})},on:{init:function(){this.scrollbar.init(),this.scrollbar.updateSize(),this.scrollbar.setTranslate()},update:function(){this.scrollbar.updateSize()},resize:function(){this.scrollbar.updateSize()},observerUpdate:function(){this.scrollbar.updateSize()},setTranslate:function(){this.scrollbar.setTranslate()},setTransition:function(e){this.scrollbar.setTransition(e)},destroy:function(){this.scrollbar.destroy()}}},Parallax={setTransform:function(e,t){var a=this.rtl,r=$(e),i=a?-1:1,n=r.attr("data-swiper-parallax")||"0",s=r.attr("data-swiper-parallax-x"),o=r.attr("data-swiper-parallax-y"),l=r.attr("data-swiper-parallax-scale"),p=r.attr("data-swiper-parallax-opacity");if(s||o?(s=s||"0",o=o||"0"):this.isHorizontal()?(s=n,o="0"):(o=n,s="0"),s=s.indexOf("%")>=0?parseInt(s,10)*t*i+"%":s*t*i+"px",o=o.indexOf("%")>=0?parseInt(o,10)*t+"%":o*t+"px",null!=p){var c=p-(p-1)*(1-Math.abs(t));r[0].style.opacity=c}if(null==l)r.transform("translate3d("+s+", "+o+", 0px)");else{var d=l-(l-1)*(1-Math.abs(t));r.transform("translate3d("+s+", "+o+", 0px) scale("+d+")")}},setTranslate:function(){var e=this,t=e.$el,a=e.slides,r=e.progress,i=e.snapGrid;t.children("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){e.parallax.setTransform(a,r)}),a.each(function(t,a){var n=a.progress;e.params.slidesPerGroup>1&&"auto"!==e.params.slidesPerView&&(n+=Math.ceil(t/2)-r*(i.length-1)),n=Math.min(Math.max(n,-1),1),$(a).find("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){e.parallax.setTransform(a,n)})})},setTransition:function(e){void 0===e&&(e=this.params.speed);this.$el.find("[data-swiper-parallax], [data-swiper-parallax-x], [data-swiper-parallax-y]").each(function(t,a){var r=$(a),i=parseInt(r.attr("data-swiper-parallax-duration"),10)||e;0===e&&(i=0),r.transition(i)})}},Parallax$1={name:"parallax",params:{parallax:{enabled:!1}},create:function(){Utils.extend(this,{parallax:{setTransform:Parallax.setTransform.bind(this),setTranslate:Parallax.setTranslate.bind(this),setTransition:Parallax.setTransition.bind(this)}})},on:{beforeInit:function(){this.params.parallax.enabled&&(this.params.watchSlidesProgress=!0,this.originalParams.watchSlidesProgress=!0)},init:function(){this.params.parallax.enabled&&this.parallax.setTranslate()},setTranslate:function(){this.params.parallax.enabled&&this.parallax.setTranslate()},setTransition:function(e){this.params.parallax.enabled&&this.parallax.setTransition(e)}}},Zoom={getDistanceBetweenTouches:function(e){if(e.targetTouches.length<2)return 1;var t=e.targetTouches[0].pageX,a=e.targetTouches[0].pageY,r=e.targetTouches[1].pageX,i=e.targetTouches[1].pageY;return Math.sqrt(Math.pow(r-t,2)+Math.pow(i-a,2))},onGestureStart:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(a.fakeGestureTouched=!1,a.fakeGestureMoved=!1,!Support.gestures){if("touchstart"!==e.type||"touchstart"===e.type&&e.targetTouches.length<2)return;a.fakeGestureTouched=!0,r.scaleStart=Zoom.getDistanceBetweenTouches(e)}r.$slideEl&&r.$slideEl.length||(r.$slideEl=$(e.target).closest(".swiper-slide"),0===r.$slideEl.length&&(r.$slideEl=this.slides.eq(this.activeIndex)),r.$imageEl=r.$slideEl.find("img, svg, canvas"),r.$imageWrapEl=r.$imageEl.parent("."+t.containerClass),r.maxRatio=r.$imageWrapEl.attr("data-swiper-zoom")||t.maxRatio,0!==r.$imageWrapEl.length)?(r.$imageEl.transition(0),this.zoom.isScaling=!0):r.$imageEl=void 0},onGestureChange:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(!Support.gestures){if("touchmove"!==e.type||"touchmove"===e.type&&e.targetTouches.length<2)return;a.fakeGestureMoved=!0,r.scaleMove=Zoom.getDistanceBetweenTouches(e)}r.$imageEl&&0!==r.$imageEl.length&&(Support.gestures?a.scale=e.scale*a.currentScale:a.scale=r.scaleMove/r.scaleStart*a.currentScale,a.scale>r.maxRatio&&(a.scale=r.maxRatio-1+Math.pow(a.scale-r.maxRatio+1,.5)),a.scale<t.minRatio&&(a.scale=t.minRatio+1-Math.pow(t.minRatio-a.scale+1,.5)),r.$imageEl.transform("translate3d(0,0,0) scale("+a.scale+")"))},onGestureEnd:function(e){var t=this.params.zoom,a=this.zoom,r=a.gesture;if(!Support.gestures){if(!a.fakeGestureTouched||!a.fakeGestureMoved)return;if("touchend"!==e.type||"touchend"===e.type&&e.changedTouches.length<2&&!Device.android)return;a.fakeGestureTouched=!1,a.fakeGestureMoved=!1}r.$imageEl&&0!==r.$imageEl.length&&(a.scale=Math.max(Math.min(a.scale,r.maxRatio),t.minRatio),r.$imageEl.transition(this.params.speed).transform("translate3d(0,0,0) scale("+a.scale+")"),a.currentScale=a.scale,a.isScaling=!1,1===a.scale&&(r.$slideEl=void 0))},onTouchStart:function(e){var t=this.zoom,a=t.gesture,r=t.image;a.$imageEl&&0!==a.$imageEl.length&&(r.isTouched||(Device.android&&e.preventDefault(),r.isTouched=!0,r.touchesStart.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,r.touchesStart.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY))},onTouchMove:function(e){var t=this.zoom,a=t.gesture,r=t.image,i=t.velocity;if(a.$imageEl&&0!==a.$imageEl.length&&(this.allowClick=!1,r.isTouched&&a.$slideEl)){r.isMoved||(r.width=a.$imageEl[0].offsetWidth,r.height=a.$imageEl[0].offsetHeight,r.startX=Utils.getTranslate(a.$imageWrapEl[0],"x")||0,r.startY=Utils.getTranslate(a.$imageWrapEl[0],"y")||0,a.slideWidth=a.$slideEl[0].offsetWidth,a.slideHeight=a.$slideEl[0].offsetHeight,a.$imageWrapEl.transition(0),this.rtl&&(r.startX=-r.startX,r.startY=-r.startY));var n=r.width*t.scale,s=r.height*t.scale;if(!(n<a.slideWidth&&s<a.slideHeight)){if(r.minX=Math.min(a.slideWidth/2-n/2,0),r.maxX=-r.minX,r.minY=Math.min(a.slideHeight/2-s/2,0),r.maxY=-r.minY,r.touchesCurrent.x="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,r.touchesCurrent.y="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,!r.isMoved&&!t.isScaling){if(this.isHorizontal()&&(Math.floor(r.minX)===Math.floor(r.startX)&&r.touchesCurrent.x<r.touchesStart.x||Math.floor(r.maxX)===Math.floor(r.startX)&&r.touchesCurrent.x>r.touchesStart.x))return void(r.isTouched=!1);if(!this.isHorizontal()&&(Math.floor(r.minY)===Math.floor(r.startY)&&r.touchesCurrent.y<r.touchesStart.y||Math.floor(r.maxY)===Math.floor(r.startY)&&r.touchesCurrent.y>r.touchesStart.y))return void(r.isTouched=!1)}e.preventDefault(),e.stopPropagation(),r.isMoved=!0,r.currentX=r.touchesCurrent.x-r.touchesStart.x+r.startX,r.currentY=r.touchesCurrent.y-r.touchesStart.y+r.startY,r.currentX<r.minX&&(r.currentX=r.minX+1-Math.pow(r.minX-r.currentX+1,.8)),r.currentX>r.maxX&&(r.currentX=r.maxX-1+Math.pow(r.currentX-r.maxX+1,.8)),r.currentY<r.minY&&(r.currentY=r.minY+1-Math.pow(r.minY-r.currentY+1,.8)),r.currentY>r.maxY&&(r.currentY=r.maxY-1+Math.pow(r.currentY-r.maxY+1,.8)),i.prevPositionX||(i.prevPositionX=r.touchesCurrent.x),i.prevPositionY||(i.prevPositionY=r.touchesCurrent.y),i.prevTime||(i.prevTime=Date.now()),i.x=(r.touchesCurrent.x-i.prevPositionX)/(Date.now()-i.prevTime)/2,i.y=(r.touchesCurrent.y-i.prevPositionY)/(Date.now()-i.prevTime)/2,Math.abs(r.touchesCurrent.x-i.prevPositionX)<2&&(i.x=0),Math.abs(r.touchesCurrent.y-i.prevPositionY)<2&&(i.y=0),i.prevPositionX=r.touchesCurrent.x,i.prevPositionY=r.touchesCurrent.y,i.prevTime=Date.now(),a.$imageWrapEl.transform("translate3d("+r.currentX+"px, "+r.currentY+"px,0)")}}},onTouchEnd:function(){var e=this.zoom,t=e.gesture,a=e.image,r=e.velocity;if(t.$imageEl&&0!==t.$imageEl.length){if(!a.isTouched||!a.isMoved)return a.isTouched=!1,void(a.isMoved=!1);a.isTouched=!1,a.isMoved=!1;var i=300,n=300,s=r.x*i,o=a.currentX+s,l=r.y*n,p=a.currentY+l;0!==r.x&&(i=Math.abs((o-a.currentX)/r.x)),0!==r.y&&(n=Math.abs((p-a.currentY)/r.y));var c=Math.max(i,n);a.currentX=o,a.currentY=p;var d=a.width*e.scale,u=a.height*e.scale;a.minX=Math.min(t.slideWidth/2-d/2,0),a.maxX=-a.minX,a.minY=Math.min(t.slideHeight/2-u/2,0),a.maxY=-a.minY,a.currentX=Math.max(Math.min(a.currentX,a.maxX),a.minX),a.currentY=Math.max(Math.min(a.currentY,a.maxY),a.minY),t.$imageWrapEl.transition(c).transform("translate3d("+a.currentX+"px, "+a.currentY+"px,0)")}},onTransitionEnd:function(){var e=this.zoom,t=e.gesture;t.$slideEl&&this.previousIndex!==this.activeIndex&&(t.$imageEl.transform("translate3d(0,0,0) scale(1)"),t.$imageWrapEl.transform("translate3d(0,0,0)"),e.scale=1,e.currentScale=1,t.$slideEl=void 0,t.$imageEl=void 0,t.$imageWrapEl=void 0)},toggle:function(e){var t=this.zoom;t.scale&&1!==t.scale?t.out():t.in(e)},in:function(e){var t,a,r,i,n,s,o,l,p,c,d,u,h,f,v,m,g=this.zoom,b=this.params.zoom,y=g.gesture,w=g.image;(y.$slideEl||(y.$slideEl=this.clickedSlide?$(this.clickedSlide):this.slides.eq(this.activeIndex),y.$imageEl=y.$slideEl.find("img, svg, canvas"),y.$imageWrapEl=y.$imageEl.parent("."+b.containerClass)),y.$imageEl&&0!==y.$imageEl.length)&&(y.$slideEl.addClass(""+b.zoomedSlideClass),void 0===w.touchesStart.x&&e?(t="touchend"===e.type?e.changedTouches[0].pageX:e.pageX,a="touchend"===e.type?e.changedTouches[0].pageY:e.pageY):(t=w.touchesStart.x,a=w.touchesStart.y),g.scale=y.$imageWrapEl.attr("data-swiper-zoom")||b.maxRatio,g.currentScale=y.$imageWrapEl.attr("data-swiper-zoom")||b.maxRatio,e?(v=y.$slideEl[0].offsetWidth,m=y.$slideEl[0].offsetHeight,r=y.$slideEl.offset().left+v/2-t,i=y.$slideEl.offset().top+m/2-a,o=y.$imageEl[0].offsetWidth,l=y.$imageEl[0].offsetHeight,p=o*g.scale,c=l*g.scale,h=-(d=Math.min(v/2-p/2,0)),f=-(u=Math.min(m/2-c/2,0)),(n=r*g.scale)<d&&(n=d),n>h&&(n=h),(s=i*g.scale)<u&&(s=u),s>f&&(s=f)):(n=0,s=0),y.$imageWrapEl.transition(300).transform("translate3d("+n+"px, "+s+"px,0)"),y.$imageEl.transition(300).transform("translate3d(0,0,0) scale("+g.scale+")"))},out:function(){var e=this.zoom,t=this.params.zoom,a=e.gesture;a.$slideEl||(a.$slideEl=this.clickedSlide?$(this.clickedSlide):this.slides.eq(this.activeIndex),a.$imageEl=a.$slideEl.find("img, svg, canvas"),a.$imageWrapEl=a.$imageEl.parent("."+t.containerClass)),a.$imageEl&&0!==a.$imageEl.length&&(e.scale=1,e.currentScale=1,a.$imageWrapEl.transition(300).transform("translate3d(0,0,0)"),a.$imageEl.transition(300).transform("translate3d(0,0,0) scale(1)"),a.$slideEl.removeClass(""+t.zoomedSlideClass),a.$slideEl=void 0)},enable:function(){var e=this.zoom;if(!e.enabled){e.enabled=!0;var t=!("touchstart"!==this.touchEvents.start||!Support.passiveListener||!this.params.passiveListeners)&&{passive:!0,capture:!1};Support.gestures?(this.$wrapperEl.on("gesturestart",".swiper-slide",e.onGestureStart,t),this.$wrapperEl.on("gesturechange",".swiper-slide",e.onGestureChange,t),this.$wrapperEl.on("gestureend",".swiper-slide",e.onGestureEnd,t)):"touchstart"===this.touchEvents.start&&(this.$wrapperEl.on(this.touchEvents.start,".swiper-slide",e.onGestureStart,t),this.$wrapperEl.on(this.touchEvents.move,".swiper-slide",e.onGestureChange,t),this.$wrapperEl.on(this.touchEvents.end,".swiper-slide",e.onGestureEnd,t)),this.$wrapperEl.on(this.touchEvents.move,"."+this.params.zoom.containerClass,e.onTouchMove)}},disable:function(){var e=this.zoom;if(e.enabled){this.zoom.enabled=!1;var t=!("touchstart"!==this.touchEvents.start||!Support.passiveListener||!this.params.passiveListeners)&&{passive:!0,capture:!1};Support.gestures?(this.$wrapperEl.off("gesturestart",".swiper-slide",e.onGestureStart,t),this.$wrapperEl.off("gesturechange",".swiper-slide",e.onGestureChange,t),this.$wrapperEl.off("gestureend",".swiper-slide",e.onGestureEnd,t)):"touchstart"===this.touchEvents.start&&(this.$wrapperEl.off(this.touchEvents.start,".swiper-slide",e.onGestureStart,t),this.$wrapperEl.off(this.touchEvents.move,".swiper-slide",e.onGestureChange,t),this.$wrapperEl.off(this.touchEvents.end,".swiper-slide",e.onGestureEnd,t)),this.$wrapperEl.off(this.touchEvents.move,"."+this.params.zoom.containerClass,e.onTouchMove)}}},Zoom$1={name:"zoom",params:{zoom:{enabled:!1,maxRatio:3,minRatio:1,toggle:!0,containerClass:"swiper-zoom-container",zoomedSlideClass:"swiper-slide-zoomed"}},create:function(){var e=this,t={enabled:!1,scale:1,currentScale:1,isScaling:!1,gesture:{$slideEl:void 0,slideWidth:void 0,slideHeight:void 0,$imageEl:void 0,$imageWrapEl:void 0,maxRatio:3},image:{isTouched:void 0,isMoved:void 0,currentX:void 0,currentY:void 0,minX:void 0,minY:void 0,maxX:void 0,maxY:void 0,width:void 0,height:void 0,startX:void 0,startY:void 0,touchesStart:{},touchesCurrent:{}},velocity:{x:void 0,y:void 0,prevPositionX:void 0,prevPositionY:void 0,prevTime:void 0}};"onGestureStart onGestureChange onGestureEnd onTouchStart onTouchMove onTouchEnd onTransitionEnd toggle enable disable in out".split(" ").forEach(function(a){t[a]=Zoom[a].bind(e)}),Utils.extend(e,{zoom:t});var a=1;Object.defineProperty(e.zoom,"scale",{get:function(){return a},set:function(t){if(a!==t){var r=e.zoom.gesture.$imageEl?e.zoom.gesture.$imageEl[0]:void 0,i=e.zoom.gesture.$slideEl?e.zoom.gesture.$slideEl[0]:void 0;e.emit("zoomChange",t,r,i)}a=t}})},on:{init:function(){this.params.zoom.enabled&&this.zoom.enable()},destroy:function(){this.zoom.disable()},touchStart:function(e){this.zoom.enabled&&this.zoom.onTouchStart(e)},touchEnd:function(e){this.zoom.enabled&&this.zoom.onTouchEnd(e)},doubleTap:function(e){this.params.zoom.enabled&&this.zoom.enabled&&this.params.zoom.toggle&&this.zoom.toggle(e)},transitionEnd:function(){this.zoom.enabled&&this.params.zoom.enabled&&this.zoom.onTransitionEnd()}}},Lazy$2={loadInSlide:function(e,t){void 0===t&&(t=!0);var a=this,r=a.params.lazy;if(void 0!==e&&0!==a.slides.length){var i=a.virtual&&a.params.virtual.enabled?a.$wrapperEl.children("."+a.params.slideClass+'[data-swiper-slide-index="'+e+'"]'):a.slides.eq(e),n=i.find("."+r.elementClass+":not(."+r.loadedClass+"):not(."+r.loadingClass+")");!i.hasClass(r.elementClass)||i.hasClass(r.loadedClass)||i.hasClass(r.loadingClass)||(n=n.add(i[0])),0!==n.length&&n.each(function(e,n){var s=$(n);s.addClass(r.loadingClass);var o=s.attr("data-background"),l=s.attr("data-src"),p=s.attr("data-srcset"),c=s.attr("data-sizes");a.loadImage(s[0],l||o,p,c,!1,function(){if(null!=a&&a&&(!a||a.params)&&!a.destroyed){if(o?(s.css("background-image",'url("'+o+'")'),s.removeAttr("data-background")):(p&&(s.attr("srcset",p),s.removeAttr("data-srcset")),c&&(s.attr("sizes",c),s.removeAttr("data-sizes")),l&&(s.attr("src",l),s.removeAttr("data-src"))),s.addClass(r.loadedClass).removeClass(r.loadingClass),i.find("."+r.preloaderClass).remove(),a.params.loop&&t){var e=i.attr("data-swiper-slide-index");if(i.hasClass(a.params.slideDuplicateClass)){var n=a.$wrapperEl.children('[data-swiper-slide-index="'+e+'"]:not(.'+a.params.slideDuplicateClass+")");a.lazy.loadInSlide(n.index(),!1)}else{var d=a.$wrapperEl.children("."+a.params.slideDuplicateClass+'[data-swiper-slide-index="'+e+'"]');a.lazy.loadInSlide(d.index(),!1)}}a.emit("lazyImageReady",i[0],s[0])}}),a.emit("lazyImageLoad",i[0],s[0])})}},load:function(){var e=this,t=e.$wrapperEl,a=e.params,r=e.slides,i=e.activeIndex,n=e.virtual&&a.virtual.enabled,s=a.lazy,o=a.slidesPerView;function l(e){if(n){if(t.children("."+a.slideClass+'[data-swiper-slide-index="'+e+'"]').length)return!0}else if(r[e])return!0;return!1}function p(e){return n?$(e).attr("data-swiper-slide-index"):$(e).index()}if("auto"===o&&(o=0),e.lazy.initialImageLoaded||(e.lazy.initialImageLoaded=!0),e.params.watchSlidesVisibility)t.children("."+a.slideVisibleClass).each(function(t,a){var r=n?$(a).attr("data-swiper-slide-index"):$(a).index();e.lazy.loadInSlide(r)});else if(o>1)for(var c=i;c<i+o;c+=1)l(c)&&e.lazy.loadInSlide(c);else e.lazy.loadInSlide(i);if(s.loadPrevNext)if(o>1||s.loadPrevNextAmount&&s.loadPrevNextAmount>1){for(var d=s.loadPrevNextAmount,u=o,h=Math.min(i+u+Math.max(d,u),r.length),f=Math.max(i-Math.max(u,d),0),v=i+o;v<h;v+=1)l(v)&&e.lazy.loadInSlide(v);for(var m=f;m<i;m+=1)l(m)&&e.lazy.loadInSlide(m)}else{var g=t.children("."+a.slideNextClass);g.length>0&&e.lazy.loadInSlide(p(g));var b=t.children("."+a.slidePrevClass);b.length>0&&e.lazy.loadInSlide(p(b))}}},Lazy$3={name:"lazy",params:{lazy:{enabled:!1,loadPrevNext:!1,loadPrevNextAmount:1,loadOnTransitionStart:!1,elementClass:"swiper-lazy",loadingClass:"swiper-lazy-loading",loadedClass:"swiper-lazy-loaded",preloaderClass:"swiper-lazy-preloader"}},create:function(){Utils.extend(this,{lazy:{initialImageLoaded:!1,load:Lazy$2.load.bind(this),loadInSlide:Lazy$2.loadInSlide.bind(this)}})},on:{beforeInit:function(){this.params.lazy.enabled&&this.params.preloadImages&&(this.params.preloadImages=!1)},init:function(){this.params.lazy.enabled&&!this.params.loop&&0===this.params.initialSlide&&this.lazy.load()},scroll:function(){this.params.freeMode&&!this.params.freeModeSticky&&this.lazy.load()},resize:function(){this.params.lazy.enabled&&this.lazy.load()},scrollbarDragMove:function(){this.params.lazy.enabled&&this.lazy.load()},transitionStart:function(){this.params.lazy.enabled&&(this.params.lazy.loadOnTransitionStart||!this.params.lazy.loadOnTransitionStart&&!this.lazy.initialImageLoaded)&&this.lazy.load()},transitionEnd:function(){this.params.lazy.enabled&&!this.params.lazy.loadOnTransitionStart&&this.lazy.load()}}},Controller={LinearSpline:function(e,t){var a,r,i,n,s,o=function(e,t){for(r=-1,a=e.length;a-r>1;)e[i=a+r>>1]<=t?r=i:a=i;return a};return this.x=e,this.y=t,this.lastIndex=e.length-1,this.interpolate=function(e){return e?(s=o(this.x,e),n=s-1,(e-this.x[n])*(this.y[s]-this.y[n])/(this.x[s]-this.x[n])+this.y[n]):0},this},getInterpolateFunction:function(e){this.controller.spline||(this.controller.spline=this.params.loop?new Controller.LinearSpline(this.slidesGrid,e.slidesGrid):new Controller.LinearSpline(this.snapGrid,e.snapGrid))},setTranslate:function(e,t){var a,r,i=this,n=i.controller.control;function s(e){var t=i.rtlTranslate?-i.translate:i.translate;"slide"===i.params.controller.by&&(i.controller.getInterpolateFunction(e),r=-i.controller.spline.interpolate(-t)),r&&"container"!==i.params.controller.by||(a=(e.maxTranslate()-e.minTranslate())/(i.maxTranslate()-i.minTranslate()),r=(t-i.minTranslate())*a+e.minTranslate()),i.params.controller.inverse&&(r=e.maxTranslate()-r),e.updateProgress(r),e.setTranslate(r,i),e.updateActiveIndex(),e.updateSlidesClasses()}if(Array.isArray(n))for(var o=0;o<n.length;o+=1)n[o]!==t&&n[o]instanceof Swiper&&s(n[o]);else n instanceof Swiper&&t!==n&&s(n)},setTransition:function(e,t){var a,r=this,i=r.controller.control;function n(t){t.setTransition(e,r),0!==e&&(t.transitionStart(),t.params.autoHeight&&Utils.nextTick(function(){t.updateAutoHeight()}),t.$wrapperEl.transitionEnd(function(){i&&(t.params.loop&&"slide"===r.params.controller.by&&t.loopFix(),t.transitionEnd())}))}if(Array.isArray(i))for(a=0;a<i.length;a+=1)i[a]!==t&&i[a]instanceof Swiper&&n(i[a]);else i instanceof Swiper&&t!==i&&n(i)}},Controller$1={name:"controller",params:{controller:{control:void 0,inverse:!1,by:"slide"}},create:function(){Utils.extend(this,{controller:{control:this.params.controller.control,getInterpolateFunction:Controller.getInterpolateFunction.bind(this),setTranslate:Controller.setTranslate.bind(this),setTransition:Controller.setTransition.bind(this)}})},on:{update:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},resize:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},observerUpdate:function(){this.controller.control&&this.controller.spline&&(this.controller.spline=void 0,delete this.controller.spline)},setTranslate:function(e,t){this.controller.control&&this.controller.setTranslate(e,t)},setTransition:function(e,t){this.controller.control&&this.controller.setTransition(e,t)}}},a11y={makeElFocusable:function(e){return e.attr("tabIndex","0"),e},addElRole:function(e,t){return e.attr("role",t),e},addElLabel:function(e,t){return e.attr("aria-label",t),e},disableEl:function(e){return e.attr("aria-disabled",!0),e},enableEl:function(e){return e.attr("aria-disabled",!1),e},onEnterKey:function(e){var t=this.params.a11y;if(13===e.keyCode){var a=$(e.target);this.navigation&&this.navigation.$nextEl&&a.is(this.navigation.$nextEl)&&(this.isEnd&&!this.params.loop||this.slideNext(),this.isEnd?this.a11y.notify(t.lastSlideMessage):this.a11y.notify(t.nextSlideMessage)),this.navigation&&this.navigation.$prevEl&&a.is(this.navigation.$prevEl)&&(this.isBeginning&&!this.params.loop||this.slidePrev(),this.isBeginning?this.a11y.notify(t.firstSlideMessage):this.a11y.notify(t.prevSlideMessage)),this.pagination&&a.is("."+this.params.pagination.bulletClass)&&a[0].click()}},notify:function(e){var t=this.a11y.liveRegion;0!==t.length&&(t.html(""),t.html(e))},updateNavigation:function(){if(!this.params.loop){var e=this.navigation,t=e.$nextEl,a=e.$prevEl;a&&a.length>0&&(this.isBeginning?this.a11y.disableEl(a):this.a11y.enableEl(a)),t&&t.length>0&&(this.isEnd?this.a11y.disableEl(t):this.a11y.enableEl(t))}},updatePagination:function(){var e=this,t=e.params.a11y;e.pagination&&e.params.pagination.clickable&&e.pagination.bullets&&e.pagination.bullets.length&&e.pagination.bullets.each(function(a,r){var i=$(r);e.a11y.makeElFocusable(i),e.a11y.addElRole(i,"button"),e.a11y.addElLabel(i,t.paginationBulletMessage.replace(/{{index}}/,i.index()+1))})},init:function(){this.$el.append(this.a11y.liveRegion);var e,t,a=this.params.a11y;this.navigation&&this.navigation.$nextEl&&(e=this.navigation.$nextEl),this.navigation&&this.navigation.$prevEl&&(t=this.navigation.$prevEl),e&&(this.a11y.makeElFocusable(e),this.a11y.addElRole(e,"button"),this.a11y.addElLabel(e,a.nextSlideMessage),e.on("keydown",this.a11y.onEnterKey)),t&&(this.a11y.makeElFocusable(t),this.a11y.addElRole(t,"button"),this.a11y.addElLabel(t,a.prevSlideMessage),t.on("keydown",this.a11y.onEnterKey)),this.pagination&&this.params.pagination.clickable&&this.pagination.bullets&&this.pagination.bullets.length&&this.pagination.$el.on("keydown","."+this.params.pagination.bulletClass,this.a11y.onEnterKey)},destroy:function(){var e,t;this.a11y.liveRegion&&this.a11y.liveRegion.length>0&&this.a11y.liveRegion.remove(),this.navigation&&this.navigation.$nextEl&&(e=this.navigation.$nextEl),this.navigation&&this.navigation.$prevEl&&(t=this.navigation.$prevEl),e&&e.off("keydown",this.a11y.onEnterKey),t&&t.off("keydown",this.a11y.onEnterKey),this.pagination&&this.params.pagination.clickable&&this.pagination.bullets&&this.pagination.bullets.length&&this.pagination.$el.off("keydown","."+this.params.pagination.bulletClass,this.a11y.onEnterKey)}},A11y={name:"a11y",params:{a11y:{enabled:!0,notificationClass:"swiper-notification",prevSlideMessage:"Previous slide",nextSlideMessage:"Next slide",firstSlideMessage:"This is the first slide",lastSlideMessage:"This is the last slide",paginationBulletMessage:"Go to slide {{index}}"}},create:function(){var e=this;Utils.extend(e,{a11y:{liveRegion:$('<span class="'+e.params.a11y.notificationClass+'" aria-live="assertive" aria-atomic="true"></span>')}}),Object.keys(a11y).forEach(function(t){e.a11y[t]=a11y[t].bind(e)})},on:{init:function(){this.params.a11y.enabled&&(this.a11y.init(),this.a11y.updateNavigation())},toEdge:function(){this.params.a11y.enabled&&this.a11y.updateNavigation()},fromEdge:function(){this.params.a11y.enabled&&this.a11y.updateNavigation()},paginationUpdate:function(){this.params.a11y.enabled&&this.a11y.updatePagination()},destroy:function(){this.params.a11y.enabled&&this.a11y.destroy()}}},Autoplay={run:function(){var e=this,t=e.slides.eq(e.activeIndex),a=e.params.autoplay.delay;t.attr("data-swiper-autoplay")&&(a=t.attr("data-swiper-autoplay")||e.params.autoplay.delay),e.autoplay.timeout=Utils.nextTick(function(){e.params.autoplay.reverseDirection?e.params.loop?(e.loopFix(),e.slidePrev(e.params.speed,!0,!0),e.emit("autoplay")):e.isBeginning?e.params.autoplay.stopOnLastSlide?e.autoplay.stop():(e.slideTo(e.slides.length-1,e.params.speed,!0,!0),e.emit("autoplay")):(e.slidePrev(e.params.speed,!0,!0),e.emit("autoplay")):e.params.loop?(e.loopFix(),e.slideNext(e.params.speed,!0,!0),e.emit("autoplay")):e.isEnd?e.params.autoplay.stopOnLastSlide?e.autoplay.stop():(e.slideTo(0,e.params.speed,!0,!0),e.emit("autoplay")):(e.slideNext(e.params.speed,!0,!0),e.emit("autoplay"))},a)},start:function(){return void 0===this.autoplay.timeout&&(!this.autoplay.running&&(this.autoplay.running=!0,this.emit("autoplayStart"),this.autoplay.run(),!0))},stop:function(){return!!this.autoplay.running&&(void 0!==this.autoplay.timeout&&(this.autoplay.timeout&&(clearTimeout(this.autoplay.timeout),this.autoplay.timeout=void 0),this.autoplay.running=!1,this.emit("autoplayStop"),!0))},pause:function(e){this.autoplay.running&&(this.autoplay.paused||(this.autoplay.timeout&&clearTimeout(this.autoplay.timeout),this.autoplay.paused=!0,0!==e&&this.params.autoplay.waitForTransition?(this.$wrapperEl[0].addEventListener("transitionend",this.autoplay.onTransitionEnd),this.$wrapperEl[0].addEventListener("webkitTransitionEnd",this.autoplay.onTransitionEnd)):(this.autoplay.paused=!1,this.autoplay.run())))}},Autoplay$1={name:"autoplay",params:{autoplay:{enabled:!1,delay:3e3,waitForTransition:!0,disableOnInteraction:!0,stopOnLastSlide:!1,reverseDirection:!1}},create:function(){var e=this;Utils.extend(e,{autoplay:{running:!1,paused:!1,run:Autoplay.run.bind(e),start:Autoplay.start.bind(e),stop:Autoplay.stop.bind(e),pause:Autoplay.pause.bind(e),onTransitionEnd:function(t){e&&!e.destroyed&&e.$wrapperEl&&t.target===this&&(e.$wrapperEl[0].removeEventListener("transitionend",e.autoplay.onTransitionEnd),e.$wrapperEl[0].removeEventListener("webkitTransitionEnd",e.autoplay.onTransitionEnd),e.autoplay.paused=!1,e.autoplay.running?e.autoplay.run():e.autoplay.stop())}}})},on:{init:function(){this.params.autoplay.enabled&&this.autoplay.start()},beforeTransitionStart:function(e,t){this.autoplay.running&&(t||!this.params.autoplay.disableOnInteraction?this.autoplay.pause(e):this.autoplay.stop())},sliderFirstMove:function(){this.autoplay.running&&(this.params.autoplay.disableOnInteraction?this.autoplay.stop():this.autoplay.pause())},destroy:function(){this.autoplay.running&&this.autoplay.stop()}}},Fade={setTranslate:function(){for(var e=this.slides,t=0;t<e.length;t+=1){var a=this.slides.eq(t),r=-a[0].swiperSlideOffset;this.params.virtualTranslate||(r-=this.translate);var i=0;this.isHorizontal()||(i=r,r=0);var n=this.params.fadeEffect.crossFade?Math.max(1-Math.abs(a[0].progress),0):1+Math.min(Math.max(a[0].progress,-1),0);a.css({opacity:n}).transform("translate3d("+r+"px, "+i+"px, 0px)")}},setTransition:function(e){var t=this,a=t.slides,r=t.$wrapperEl;if(a.transition(e),t.params.virtualTranslate&&0!==e){var i=!1;a.transitionEnd(function(){if(!i&&t&&!t.destroyed){i=!0,t.animating=!1;for(var e=["webkitTransitionEnd","transitionend"],a=0;a<e.length;a+=1)r.trigger(e[a])}})}}},EffectFade={name:"effect-fade",params:{fadeEffect:{crossFade:!1}},create:function(){Utils.extend(this,{fadeEffect:{setTranslate:Fade.setTranslate.bind(this),setTransition:Fade.setTransition.bind(this)}})},on:{beforeInit:function(){if("fade"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"fade");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,spaceBetween:0,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"fade"===this.params.effect&&this.fadeEffect.setTranslate()},setTransition:function(e){"fade"===this.params.effect&&this.fadeEffect.setTransition(e)}}},Cube={setTranslate:function(){var e,t=this.$el,a=this.$wrapperEl,r=this.slides,i=this.width,n=this.height,s=this.rtlTranslate,o=this.size,l=this.params.cubeEffect,p=this.isHorizontal(),c=this.virtual&&this.params.virtual.enabled,d=0;l.shadow&&(p?(0===(e=a.find(".swiper-cube-shadow")).length&&(e=$('<div class="swiper-cube-shadow"></div>'),a.append(e)),e.css({height:i+"px"})):0===(e=t.find(".swiper-cube-shadow")).length&&(e=$('<div class="swiper-cube-shadow"></div>'),t.append(e)));for(var u=0;u<r.length;u+=1){var h=r.eq(u),f=u;c&&(f=parseInt(h.attr("data-swiper-slide-index"),10));var v=90*f,m=Math.floor(v/360);s&&(v=-v,m=Math.floor(-v/360));var g=Math.max(Math.min(h[0].progress,1),-1),b=0,y=0,w=0;f%4==0?(b=4*-m*o,w=0):(f-1)%4==0?(b=0,w=4*-m*o):(f-2)%4==0?(b=o+4*m*o,w=o):(f-3)%4==0&&(b=-o,w=3*o+4*o*m),s&&(b=-b),p||(y=b,b=0);var C="rotateX("+(p?0:-v)+"deg) rotateY("+(p?v:0)+"deg) translate3d("+b+"px, "+y+"px, "+w+"px)";if(g<=1&&g>-1&&(d=90*f+90*g,s&&(d=90*-f-90*g)),h.transform(C),l.slideShadows){var x=p?h.find(".swiper-slide-shadow-left"):h.find(".swiper-slide-shadow-top"),k=p?h.find(".swiper-slide-shadow-right"):h.find(".swiper-slide-shadow-bottom");0===x.length&&(x=$('<div class="swiper-slide-shadow-'+(p?"left":"top")+'"></div>'),h.append(x)),0===k.length&&(k=$('<div class="swiper-slide-shadow-'+(p?"right":"bottom")+'"></div>'),h.append(k)),x.length&&(x[0].style.opacity=Math.max(-g,0)),k.length&&(k[0].style.opacity=Math.max(g,0))}}if(a.css({"-webkit-transform-origin":"50% 50% -"+o/2+"px","-moz-transform-origin":"50% 50% -"+o/2+"px","-ms-transform-origin":"50% 50% -"+o/2+"px","transform-origin":"50% 50% -"+o/2+"px"}),l.shadow)if(p)e.transform("translate3d(0px, "+(i/2+l.shadowOffset)+"px, "+-i/2+"px) rotateX(90deg) rotateZ(0deg) scale("+l.shadowScale+")");else{var E=Math.abs(d)-90*Math.floor(Math.abs(d)/90),S=1.5-(Math.sin(2*E*Math.PI/360)/2+Math.cos(2*E*Math.PI/360)/2),T=l.shadowScale,M=l.shadowScale/S,P=l.shadowOffset;e.transform("scale3d("+T+", 1, "+M+") translate3d(0px, "+(n/2+P)+"px, "+-n/2/M+"px) rotateX(-90deg)")}var O=Browser.isSafari||Browser.isUiWebView?-o/2:0;a.transform("translate3d(0px,0,"+O+"px) rotateX("+(this.isHorizontal()?0:d)+"deg) rotateY("+(this.isHorizontal()?-d:0)+"deg)")},setTransition:function(e){var t=this.$el;this.slides.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e),this.params.cubeEffect.shadow&&!this.isHorizontal()&&t.find(".swiper-cube-shadow").transition(e)}},EffectCube={name:"effect-cube",params:{cubeEffect:{slideShadows:!0,shadow:!0,shadowOffset:20,shadowScale:.94}},create:function(){Utils.extend(this,{cubeEffect:{setTranslate:Cube.setTranslate.bind(this),setTransition:Cube.setTransition.bind(this)}})},on:{beforeInit:function(){if("cube"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"cube"),this.classNames.push(this.params.containerModifierClass+"3d");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,resistanceRatio:0,spaceBetween:0,centeredSlides:!1,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"cube"===this.params.effect&&this.cubeEffect.setTranslate()},setTransition:function(e){"cube"===this.params.effect&&this.cubeEffect.setTransition(e)}}},Flip={setTranslate:function(){for(var e=this.slides,t=this.rtlTranslate,a=0;a<e.length;a+=1){var r=e.eq(a),i=r[0].progress;this.params.flipEffect.limitRotation&&(i=Math.max(Math.min(r[0].progress,1),-1));var n=-180*i,s=0,o=-r[0].swiperSlideOffset,l=0;if(this.isHorizontal()?t&&(n=-n):(l=o,o=0,s=-n,n=0),r[0].style.zIndex=-Math.abs(Math.round(i))+e.length,this.params.flipEffect.slideShadows){var p=this.isHorizontal()?r.find(".swiper-slide-shadow-left"):r.find(".swiper-slide-shadow-top"),c=this.isHorizontal()?r.find(".swiper-slide-shadow-right"):r.find(".swiper-slide-shadow-bottom");0===p.length&&(p=$('<div class="swiper-slide-shadow-'+(this.isHorizontal()?"left":"top")+'"></div>'),r.append(p)),0===c.length&&(c=$('<div class="swiper-slide-shadow-'+(this.isHorizontal()?"right":"bottom")+'"></div>'),r.append(c)),p.length&&(p[0].style.opacity=Math.max(-i,0)),c.length&&(c[0].style.opacity=Math.max(i,0))}r.transform("translate3d("+o+"px, "+l+"px, 0px) rotateX("+s+"deg) rotateY("+n+"deg)")}},setTransition:function(e){var t=this,a=t.slides,r=t.activeIndex,i=t.$wrapperEl;if(a.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e),t.params.virtualTranslate&&0!==e){var n=!1;a.eq(r).transitionEnd(function(){if(!n&&t&&!t.destroyed){n=!0,t.animating=!1;for(var e=["webkitTransitionEnd","transitionend"],a=0;a<e.length;a+=1)i.trigger(e[a])}})}}},EffectFlip={name:"effect-flip",params:{flipEffect:{slideShadows:!0,limitRotation:!0}},create:function(){Utils.extend(this,{flipEffect:{setTranslate:Flip.setTranslate.bind(this),setTransition:Flip.setTransition.bind(this)}})},on:{beforeInit:function(){if("flip"===this.params.effect){this.classNames.push(this.params.containerModifierClass+"flip"),this.classNames.push(this.params.containerModifierClass+"3d");var e={slidesPerView:1,slidesPerColumn:1,slidesPerGroup:1,watchSlidesProgress:!0,spaceBetween:0,virtualTranslate:!0};Utils.extend(this.params,e),Utils.extend(this.originalParams,e)}},setTranslate:function(){"flip"===this.params.effect&&this.flipEffect.setTranslate()},setTransition:function(e){"flip"===this.params.effect&&this.flipEffect.setTransition(e)}}},Coverflow={setTranslate:function(){for(var e=this.width,t=this.height,a=this.slides,r=this.$wrapperEl,i=this.slidesSizesGrid,n=this.params.coverflowEffect,s=this.isHorizontal(),o=this.translate,l=s?e/2-o:t/2-o,p=s?n.rotate:-n.rotate,c=n.depth,d=0,u=a.length;d<u;d+=1){var h=a.eq(d),f=i[d],v=(l-h[0].swiperSlideOffset-f/2)/f*n.modifier,m=s?p*v:0,g=s?0:p*v,b=-c*Math.abs(v),y=s?0:n.stretch*v,w=s?n.stretch*v:0;Math.abs(w)<.001&&(w=0),Math.abs(y)<.001&&(y=0),Math.abs(b)<.001&&(b=0),Math.abs(m)<.001&&(m=0),Math.abs(g)<.001&&(g=0);var C="translate3d("+w+"px,"+y+"px,"+b+"px)  rotateX("+g+"deg) rotateY("+m+"deg)";if(h.transform(C),h[0].style.zIndex=1-Math.abs(Math.round(v)),n.slideShadows){var x=s?h.find(".swiper-slide-shadow-left"):h.find(".swiper-slide-shadow-top"),k=s?h.find(".swiper-slide-shadow-right"):h.find(".swiper-slide-shadow-bottom");0===x.length&&(x=$('<div class="swiper-slide-shadow-'+(s?"left":"top")+'"></div>'),h.append(x)),0===k.length&&(k=$('<div class="swiper-slide-shadow-'+(s?"right":"bottom")+'"></div>'),h.append(k)),x.length&&(x[0].style.opacity=v>0?v:0),k.length&&(k[0].style.opacity=-v>0?-v:0)}}(Support.pointerEvents||Support.prefixedPointerEvents)&&(r[0].style.perspectiveOrigin=l+"px 50%")},setTransition:function(e){this.slides.transition(e).find(".swiper-slide-shadow-top, .swiper-slide-shadow-right, .swiper-slide-shadow-bottom, .swiper-slide-shadow-left").transition(e)}},EffectCoverflow={name:"effect-coverflow",params:{coverflowEffect:{rotate:50,stretch:0,depth:100,modifier:1,slideShadows:!0}},create:function(){Utils.extend(this,{coverflowEffect:{setTranslate:Coverflow.setTranslate.bind(this),setTransition:Coverflow.setTransition.bind(this)}})},on:{beforeInit:function(){"coverflow"===this.params.effect&&(this.classNames.push(this.params.containerModifierClass+"coverflow"),this.classNames.push(this.params.containerModifierClass+"3d"),this.params.watchSlidesProgress=!0,this.originalParams.watchSlidesProgress=!0)},setTranslate:function(){"coverflow"===this.params.effect&&this.coverflowEffect.setTranslate()},setTransition:function(e){"coverflow"===this.params.effect&&this.coverflowEffect.setTransition(e)}}},Thumbs={init:function(){var e=this.params.thumbs,t=this.constructor;e.swiper instanceof t?(this.thumbs.swiper=e.swiper,Utils.extend(this.thumbs.swiper.originalParams,{watchSlidesProgress:!0,slideToClickedSlide:!1}),Utils.extend(this.thumbs.swiper.params,{watchSlidesProgress:!0,slideToClickedSlide:!1})):Utils.isObject(e.swiper)&&(this.thumbs.swiper=new t(Utils.extend({},e.swiper,{watchSlidesVisibility:!0,watchSlidesProgress:!0,slideToClickedSlide:!1})),this.thumbs.swiperCreated=!0),this.thumbs.swiper.$el.addClass(this.params.thumbs.thumbsContainerClass),this.thumbs.swiper.on("tap",this.thumbs.onThumbClick)},onThumbClick:function(){var e=this.thumbs.swiper;if(e){var t=e.clickedIndex,a=e.clickedSlide;if(!(a&&$(a).hasClass(this.params.thumbs.slideThumbActiveClass)||null==t)){var r;if(r=e.params.loop?parseInt($(e.clickedSlide).attr("data-swiper-slide-index"),10):t,this.params.loop){var i=this.activeIndex;this.slides.eq(i).hasClass(this.params.slideDuplicateClass)&&(this.loopFix(),this._clientLeft=this.$wrapperEl[0].clientLeft,i=this.activeIndex);var n=this.slides.eq(i).prevAll('[data-swiper-slide-index="'+r+'"]').eq(0).index(),s=this.slides.eq(i).nextAll('[data-swiper-slide-index="'+r+'"]').eq(0).index();r=void 0===n?s:void 0===s?n:s-i<i-n?s:n}this.slideTo(r)}}},update:function(e){var t=this.thumbs.swiper;if(t){var a="auto"===t.params.slidesPerView?t.slidesPerViewDynamic():t.params.slidesPerView;if(this.realIndex!==t.realIndex){var r,i=t.activeIndex;if(t.params.loop){t.slides.eq(i).hasClass(t.params.slideDuplicateClass)&&(t.loopFix(),t._clientLeft=t.$wrapperEl[0].clientLeft,i=t.activeIndex);var n=t.slides.eq(i).prevAll('[data-swiper-slide-index="'+this.realIndex+'"]').eq(0).index(),s=t.slides.eq(i).nextAll('[data-swiper-slide-index="'+this.realIndex+'"]').eq(0).index();r=void 0===n?s:void 0===s?n:s-i==i-n?i:s-i<i-n?s:n}else r=this.realIndex;t.visibleSlidesIndexes.indexOf(r)<0&&(t.params.centeredSlides?r=r>i?r-Math.floor(a/2)+1:r+Math.floor(a/2)-1:r>i&&(r=r-a+1),t.slideTo(r,e?0:void 0))}var o=1,l=this.params.thumbs.slideThumbActiveClass;if(this.params.slidesPerView>1&&!this.params.centeredSlides&&(o=this.params.slidesPerView),t.slides.removeClass(l),t.params.loop)for(var p=0;p<o;p+=1)t.$wrapperEl.children('[data-swiper-slide-index="'+(this.realIndex+p)+'"]').addClass(l);else for(var c=0;c<o;c+=1)t.slides.eq(this.realIndex+c).addClass(l)}}},Thumbs$1={name:"thumbs",params:{thumbs:{swiper:null,slideThumbActiveClass:"swiper-slide-thumb-active",thumbsContainerClass:"swiper-container-thumbs"}},create:function(){Utils.extend(this,{thumbs:{swiper:null,init:Thumbs.init.bind(this),update:Thumbs.update.bind(this),onThumbClick:Thumbs.onThumbClick.bind(this)}})},on:{beforeInit:function(){var e=this.params.thumbs;e&&e.swiper&&(this.thumbs.init(),this.thumbs.update(!0))},slideChange:function(){this.thumbs.swiper&&this.thumbs.update()},update:function(){this.thumbs.swiper&&this.thumbs.update()},resize:function(){this.thumbs.swiper&&this.thumbs.update()},observerUpdate:function(){this.thumbs.swiper&&this.thumbs.update()},setTransition:function(e){var t=this.thumbs.swiper;t&&t.setTransition(e)},beforeDestroy:function(){var e=this.thumbs.swiper;e&&this.thumbs.swiperCreated&&e&&e.destroy()}}};function initSwiper(e){var t=this,a=$(e);if(0!==a.length&&!a[0].swiper){var r,i,n,s={};a.hasClass("tabs-swipeable-wrap")&&(a.addClass("swiper-container").children(".tabs").addClass("swiper-wrapper").children(".tab").addClass("swiper-slide"),r=a.children(".tabs").children(".tab-active").index(),i=!0,n=a.find(".tabs-routable").length>0),a.attr("data-swiper")?s=JSON.parse(a.attr("data-swiper")):(s=a.dataset(),Object.keys(s).forEach(function(e){var t=s[e];if("string"==typeof t&&0===t.indexOf("{")&&t.indexOf("}")>0)try{s[e]=JSON.parse(t)}catch(e){}})),void 0===s.initialSlide&&void 0!==r&&(s.initialSlide=r);var o=t.swiper.create(a[0],s);i&&o.on("slideChange",function(){if(n){var e=t.views.get(a.parents(".view"));e||(e=t.views.main);var r=e.router,i=r.findTabRoute(o.slides.eq(o.activeIndex)[0]);i&&setTimeout(function(){r.navigate(i.path)},0)}else t.tab.show({tabEl:o.slides.eq(o.activeIndex)})})}}Swiper.use([Device$1,Browser$1,Support$1,Resize,Observer$1,Virtual$1,Navigation$1,Pagination$1,Scrollbar$1,Parallax$1,Zoom$1,Lazy$3,Controller$1,A11y,Autoplay$1,EffectFade,EffectCube,EffectFlip,EffectCoverflow,Thumbs$1]),window.Swiper||(window.Swiper=Swiper);var Swiper$1={name:"swiper",static:{Swiper:Swiper},create:function(){this.swiper=ConstructorMethods({defaultSelector:".swiper-container",constructor:Swiper,domProp:"swiper"})},on:{pageBeforeRemove:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){t.swiper.destroy(a)})},pageMounted:function(e){var t=this;e.$el.find(".tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},pageInit:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},pageReinit:function(e){var t=this;e.$el.find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){var r=t.swiper.get(a);r&&r.update&&r.update()})},tabMounted:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){initSwiper.call(t,a)})},tabShow:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){var r=t.swiper.get(a);r&&r.update&&r.update()})},tabBeforeRemove:function(e){var t=this;$(e).find(".swiper-init, .tabs-swipeable-wrap").each(function(e,a){t.swiper.destroy(a)})}},vnode:{"swiper-init":{insert:function(e){var t=e.elm;initSwiper.call(this,t)},destroy:function(e){var t=e.elm;this.swiper.destroy(t)}},"tabs-swipeable-wrap":{insert:function(e){var t=e.elm;initSwiper.call(this,t)},destroy:function(e){var t=e.elm;this.swiper.destroy(t)}}}},PhotoBrowser=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this;r.app=t;var i=Utils.extend({on:{}},t.params.photoBrowser);r.useModulesParams(i),r.params=Utils.extend(i,a),Utils.extend(r,{exposed:!1,opened:!1,activeIndex:r.params.swiper.initialSlide,url:r.params.url,view:r.params.view||t.views.main,swipeToClose:{allow:!0,isTouched:!1,diff:void 0,start:void 0,current:void 0,started:!1,activeSlide:void 0,timeStart:void 0}}),r.useModules(),r.init()}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.onSlideChange=function(e){var t=this;t.activeIndex=e.activeIndex;var a=e.activeIndex+1,r=t.params.virtualSlides?t.params.photos.length:e.slides.length;e.params.loop&&(r-=2,(a-=e.loopedSlides)<1&&(a=r+a),a>r&&(a-=r));var i=t.params.virtualSlides?e.$wrapperEl.find('.swiper-slide[data-swiper-slide-index="'+e.activeIndex+'"]'):e.slides.eq(e.activeIndex),n=t.params.virtualSlides?e.$wrapperEl.find('.swiper-slide[data-swiper-slide-index="'+e.previousIndex+'"]'):e.slides.eq(e.previousIndex),s=t.$el.find(".photo-browser-current"),o=t.$el.find(".photo-browser-total");if("page"===t.params.type&&t.params.navbar&&0===s.length&&"ios"===t.app.theme){var l=t.app.navbar.getElByPage(t.$el);l&&(s=$(l).find(".photo-browser-current"),o=$(l).find(".photo-browser-total"))}if(s.text(a),o.text(r),t.captions.length>0){var p=e.params.loop?i.attr("data-swiper-slide-index"):t.activeIndex;t.$captionsContainerEl.find(".photo-browser-caption-active").removeClass("photo-browser-caption-active"),t.$captionsContainerEl.find('[data-caption-index="'+p+'"]').addClass("photo-browser-caption-active")}var c=n.find("video");c.length>0&&"pause"in c[0]&&c[0].pause()},t.prototype.onTouchStart=function(){var e=this.swipeToClose;e.allow&&(e.isTouched=!0)},t.prototype.onTouchMove=function(e){var t=this,a=t.swipeToClose;if(a.isTouched){a.started||(a.started=!0,a.start="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,t.params.virtualSlides?a.activeSlide=t.swiper.$wrapperEl.children(".swiper-slide-active"):a.activeSlide=t.swiper.slides.eq(t.swiper.activeIndex),a.timeStart=Utils.now()),e.preventDefault(),a.current="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,a.diff=a.start-a.current;var r=1-Math.abs(a.diff)/300,i=t.exposed||"dark"===t.params.theme?0:255;a.activeSlide.transform("translate3d(0,"+-a.diff+"px,0)"),t.swiper.$el.css("background-color","rgba("+i+", "+i+", "+i+", "+r+")").transition(0)}},t.prototype.onTouchEnd=function(){var e=this,t=e.swipeToClose;if(t.isTouched=!1,t.started){t.started=!1,t.allow=!1;var a=Math.abs(t.diff),r=(new Date).getTime()-t.timeStart;r<300&&a>20||r>=300&&a>100?Utils.nextTick(function(){e.$el&&(t.diff<0?e.$el.addClass("swipe-close-to-bottom"):e.$el.addClass("swipe-close-to-top")),e.emit("local::swipeToClose",e),e.close(),t.allow=!0}):(0!==a?t.activeSlide.addClass("photo-browser-transitioning").transitionEnd(function(){t.allow=!0,t.activeSlide.removeClass("photo-browser-transitioning")}):t.allow=!0,e.swiper.$el.transition("").css("background-color",""),t.activeSlide.transform(""))}else t.started=!1},t.prototype.renderNavbar=function(){var e=this;if(e.params.renderNavbar)return e.params.renderNavbar.call(e);var t=e.params.iconsColor;e.params.iconsColor||"dark"!==e.params.theme||(t="white");var a="ios"!==e.app.theme&&"aurora"!==e.app.theme||!e.params.backLinkText?"":e.params.backLinkText,r="page"!==e.params.type;return('\n      <div class="navbar">\n        <div class="navbar-inner sliding">\n          <div class="left">\n            <a class="link '+(r?"popup-close":"")+" "+(a?"":"icon-only")+" "+(r?"":"back")+'" '+(r?'data-popup=".photo-browser-popup"':"")+'>\n              <i class="icon icon-back '+(t?"color-"+t:"")+'"></i>\n              '+(a?"<span>"+a+"</span>":"")+'\n            </a>\n          </div>\n          <div class="title">\n            <span class="photo-browser-current"></span>\n            <span class="photo-browser-of">'+e.params.navbarOfText+'</span>\n            <span class="photo-browser-total"></span>\n          </div>\n          <div class="right"></div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderToolbar=function(){var e=this;if(e.params.renderToolbar)return e.params.renderToolbar.call(e);var t=e.params.iconsColor;return e.params.iconsColor||"dark"!==e.params.theme||(t="white"),('\n      <div class="toolbar toolbar-bottom tabbar">\n        <div class="toolbar-inner">\n          <a class="link photo-browser-prev">\n            <i class="icon icon-back '+(t?"color-"+t:"")+'"></i>\n          </a>\n          <a class="link photo-browser-next">\n            <i class="icon icon-forward '+(t?"color-"+t:"")+'"></i>\n          </a>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderCaption=function(e,t){return this.params.renderCaption?this.params.renderCaption.call(this,e,t):('\n      <div class="photo-browser-caption" data-caption-index="'+t+'">\n        '+e+"\n      </div>\n    ").trim()},t.prototype.renderObject=function(e,t){return this.params.renderObject?this.params.renderObject.call(this,e,t):'\n      <div class="photo-browser-slide photo-browser-object-slide swiper-slide" data-swiper-slide-index="'+t+'">'+(e.html?e.html:e)+"</div>\n    "},t.prototype.renderLazyPhoto=function(e,t){var a=this;return a.params.renderLazyPhoto?a.params.renderLazyPhoto.call(a,e,t):('\n      <div class="photo-browser-slide photo-browser-slide-lazy swiper-slide" data-swiper-slide-index="'+t+'">\n          <div class="preloader swiper-lazy-preloader '+("dark"===a.params.theme?"color-white":"")+'">'+(Utils[a.app.theme+"PreloaderContent"]||"")+'</div>\n          <span class="swiper-zoom-container">\n              <img data-src="'+(e.url?e.url:e)+'" class="swiper-lazy">\n          </span>\n      </div>\n    ').trim()},t.prototype.renderPhoto=function(e,t){return this.params.renderPhoto?this.params.renderPhoto.call(this,e,t):('\n      <div class="photo-browser-slide swiper-slide" data-swiper-slide-index="'+t+'">\n        <span class="swiper-zoom-container">\n          <img src="'+(e.url?e.url:e)+'">\n        </span>\n      </div>\n    ').trim()},t.prototype.render=function(){var e=this;return e.params.render?e.params.render.call(e,e.params):('\n      <div class="photo-browser photo-browser-'+e.params.theme+'">\n        <div class="view">\n          <div class="page photo-browser-page photo-browser-page-'+e.params.theme+" no-toolbar "+(e.params.navbar?"":"no-navbar")+'" data-name="photo-browser-page">\n            '+(e.params.navbar?e.renderNavbar():"")+"\n            "+(e.params.toolbar?e.renderToolbar():"")+'\n            <div class="photo-browser-captions photo-browser-captions-'+(e.params.captionsTheme||e.params.theme)+'">\n              '+e.params.photos.map(function(t,a){return t.caption?e.renderCaption(t.caption,a):""}).join(" ")+'\n            </div>\n            <div class="photo-browser-swiper-container swiper-container">\n              <div class="photo-browser-swiper-wrapper swiper-wrapper">\n                '+(e.params.virtualSlides?"":e.params.photos.map(function(t,a){return t.html||("string"==typeof t||t instanceof String)&&t.indexOf("<")>=0&&t.indexOf(">")>=0?e.renderObject(t,a):!0===e.params.swiper.lazy||e.params.swiper.lazy&&e.params.swiper.lazy.enabled?e.renderLazyPhoto(t,a):e.renderPhoto(t,a)}).join(" "))+"\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderStandalone=function(){return this.params.renderStandalone?this.params.renderStandalone.call(this):'<div class="popup photo-browser-popup photo-browser-standalone popup-tablet-fullscreen">'+this.render()+"</div>"},t.prototype.renderPage=function(){return this.params.renderPage?this.params.renderPage.call(this):this.render()},t.prototype.renderPopup=function(){return this.params.renderPopup?this.params.renderPopup.call(this):'<div class="popup photo-browser-popup">'+this.render()+"</div>"},t.prototype.onOpen=function(e,t){var a=this,r=a.app,i=$(t);i[0].f7PhotoBrowser=a,a.$el=i,a.el=i[0],a.openedIn=e,a.opened=!0,a.$swiperContainerEl=a.$el.find(".photo-browser-swiper-container"),a.$swiperWrapperEl=a.$el.find(".photo-browser-swiper-wrapper"),a.slides=a.$el.find(".photo-browser-slide"),a.$captionsContainerEl=a.$el.find(".photo-browser-captions"),a.captions=a.$el.find(".photo-browser-caption");var n=Utils.extend({},a.params.swiper,{initialSlide:a.activeIndex,on:{tap:function(e){a.emit("local::tap",e)},click:function(e){a.params.exposition&&a.expositionToggle(),a.emit("local::click",e)},doubleTap:function(e){a.emit("local::doubleTap",e)},slideChange:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.onSlideChange(this),a.emit.apply(a,["local::slideChange"].concat(e))},transitionStart:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::transitionStart"].concat(e))},transitionEnd:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::transitionEnd"].concat(e))},slideChangeTransitionStart:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::slideChangeTransitionStart"].concat(e))},slideChangeTransitionEnd:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::slideChangeTransitionEnd"].concat(e))},lazyImageLoad:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];a.emit.apply(a,["local::lazyImageLoad"].concat(e))},lazyImageReady:function(){for(var e=[],t=arguments.length;t--;)e[t]=arguments[t];$(e[0]).removeClass("photo-browser-slide-lazy"),a.emit.apply(a,["local::lazyImageReady"].concat(e))}}});a.params.swipeToClose&&"page"!==a.params.type&&Utils.extend(n.on,{touchStart:function(e){a.onTouchStart(e),a.emit("local::touchStart",e)},touchMoveOpposite:function(e){a.onTouchMove(e),a.emit("local::touchMoveOpposite",e)},touchEnd:function(e){a.onTouchEnd(e),a.emit("local::touchEnd",e)}}),a.params.virtualSlides&&Utils.extend(n,{virtual:{slides:a.params.photos,renderSlide:function(e,t){return e.html||("string"==typeof e||e instanceof String)&&e.indexOf("<")>=0&&e.indexOf(">")>=0?a.renderObject(e,t):!0===a.params.swiper.lazy||a.params.swiper.lazy&&a.params.swiper.lazy.enabled?a.renderLazyPhoto(e,t):a.renderPhoto(e,t)}}}),a.swiper=r.swiper.create(a.$swiperContainerEl,n),0===a.activeIndex&&a.onSlideChange(a.swiper),a.$el&&a.$el.trigger("photobrowser:open"),a.emit("local::open photoBrowserOpen",a)},t.prototype.onOpened=function(){this.$el&&this.$el.trigger("photobrowser:opened"),this.emit("local::opened photoBrowserOpened",this)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.swiper&&e.swiper.destroy&&(e.swiper.destroy(!0,!1),e.swiper=null,delete e.swiper),e.$el&&e.$el.trigger("photobrowser:close"),e.emit("local::close photoBrowserClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$el=null,e.el=null,delete e.$el,delete e.el,e.$el&&e.$el.trigger("photobrowser:closed"),e.emit("local::closed photoBrowserClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;var t=e.renderPage();return e.view.router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.view.$el.addClass("with-photo-browser-page with-photo-browser-page-"+e.params.theme),e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.view.$el.removeClass("with-photo-browser-page with-photo-browser-page-exposed with-photo-browser-page-"+e.params.theme),e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}}}}),e},t.prototype.openStandalone=function(){var e=this;if(e.opened)return e;var t={backdrop:!1,content:e.renderStandalone(),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;var t={content:e.renderPopup(),on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(),e},t.prototype.expositionEnable=function(){var e=this;return"page"===e.params.type&&e.view.$el.addClass("with-photo-browser-page-exposed"),e.$el&&e.$el.addClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.addClass("photo-browser-captions-exposed"),e.exposed=!0,e},t.prototype.expositionDisable=function(){var e=this;return"page"===e.params.type&&e.view.$el.removeClass("with-photo-browser-page-exposed"),e.$el&&e.$el.removeClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.removeClass("photo-browser-captions-exposed"),e.exposed=!1,e},t.prototype.expositionToggle=function(){var e=this;return"page"===e.params.type&&e.view.$el.toggleClass("with-photo-browser-page-exposed"),e.$el&&e.$el.toggleClass("photo-browser-exposed"),e.params.expositionHideCaptions&&e.$captionsContainerEl.toggleClass("photo-browser-captions-exposed"),e.exposed=!e.exposed,e},t.prototype.open=function(e){var t=this,a=t.params.type;return t.opened?(t.swiper&&void 0!==e&&t.swiper.slideTo(parseInt(e,10)),t):(void 0!==e&&(t.activeIndex=e),"standalone"===a&&t.openStandalone(),"page"===a&&t.openPage(),"popup"===a&&t.openPopup(),t)},t.prototype.close=function(){var e=this;return e.opened?(e.params.routableModals||"page"===e.openedIn?e.view&&e.view.router.back():(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.destroyed||(e.modal.destroy(),delete e.modal)})}),e.modal.close()),e):e},t.prototype.init=function(){},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy photoBrowserBeforeDestroy",e),e.$el&&(e.$el.trigger("photobrowser:beforedestroy"),e.$el[0].f7PhotoBrowser=null,delete e.$el[0].f7PhotoBrowser),Utils.deleteProps(e),e.destroyed=!0,e=null},t}(Framework7Class),PhotoBrowser$1={name:"photoBrowser",params:{photoBrowser:{photos:[],exposition:!0,expositionHideCaptions:!1,type:"standalone",navbar:!0,toolbar:!0,theme:"light",captionsTheme:void 0,iconsColor:void 0,swipeToClose:!0,backLinkText:"Close",navbarOfText:"of",view:void 0,url:"photos/",routableModals:!0,virtualSlides:!0,renderNavbar:void 0,renderToolbar:void 0,renderCaption:void 0,renderObject:void 0,renderLazyPhoto:void 0,renderPhoto:void 0,renderPage:void 0,renderPopup:void 0,renderStandalone:void 0,swiper:{initialSlide:0,spaceBetween:20,speed:300,loop:!1,preloadImages:!0,navigation:{nextEl:".photo-browser-next",prevEl:".photo-browser-prev"},zoom:{enabled:!0,maxRatio:3,minRatio:1},lazy:{enabled:!0}}}},create:function(){this.photoBrowser=ConstructorMethods({defaultSelector:".photo-browser",constructor:PhotoBrowser,app:this,domProp:"f7PhotoBrowser"})},static:{PhotoBrowser:PhotoBrowser}},Notification=function(e){function t(t,a){var r=Utils.extend({on:{}},t.params.notification,a);e.call(this,t,r);var i=this;i.app=t,i.params=r;var n,s,o,l,p,c,d,u=i.params,h=u.icon,f=u.title,v=u.titleRightText,m=u.subtitle,g=u.text,b=u.closeButton,y=u.closeTimeout,w=u.cssClass,C=u.closeOnClick;if(i.params.el)n=$(i.params.el);else{var x=i.render({icon:h,title:f,titleRightText:v,subtitle:m,text:g,closeButton:b,cssClass:w});n=$(x)}if(n&&n.length>0&&n[0].f7Modal)return n[0].f7Modal;if(0===n.length)return i.destroy();Utils.extend(i,{$el:n,el:n[0],type:"notification"}),n[0].f7Modal=i,b&&n.find(".notification-close-button").on("click",function(){i.close()}),n.on("click",function(e){b&&$(e.target).closest(".notification-close-button").length||(i.emit("local::click notificationClick",i),C&&i.close())}),i.on("beforeDestroy",function(){n.off("click")});var k,E={};function S(e){s||(s=!0,o=!1,l=void 0,c=Utils.now(),E.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,E.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY)}function T(e){if(s){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;if(void 0===l&&(l=!!(l||Math.abs(a-E.y)<Math.abs(t-E.x))),l)s=!1;else{e.preventDefault(),o||(i.$el.removeClass("notification-transitioning"),i.$el.transition(0),d=i.$el[0].offsetHeight/2),o=!0;var r=p=a-E.y;p>0&&(r=Math.pow(p,.8)),i.$el.transform("translate3d(0, "+r+"px, 0)")}}}function M(){if(!s||!o)return s=!1,void(o=!1);if(s=!1,o=!1,0!==p){var e=Utils.now()-c;i.$el.transition(""),i.$el.addClass("notification-transitioning"),i.$el.transform(""),(p<-10&&e<300||-p>=d/1)&&i.close()}}return i.on("open",function(){i.params.swipeToClose&&(i.$el.on(t.touchEvents.start,S,{passive:!0}),t.on("touchmove:active",T),t.on("touchend:passive",M)),$(".notification.modal-in").each(function(e,a){var r=t.notification.get(a);a!==i.el&&r&&r.close()}),y&&function e(){k=Utils.nextTick(function(){s&&o?e():i.close()},y)}()}),i.on("close beforeDestroy",function(){i.params.swipeToClose&&(i.$el.off(t.touchEvents.start,S,{passive:!0}),t.off("touchmove:active",T),t.off("touchend:passive",M)),win.clearTimeout(k)}),i}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.icon,a=e.title,r=e.titleRightText,i=e.subtitle,n=e.text,s=e.closeButton;return('\n      <div class="notification '+(e.cssClass||"")+'">\n        <div class="notification-header">\n          '+(t?'<div class="notification-icon">'+t+"</div>":"")+"\n          "+(a?'<div class="notification-title">'+a+"</div>":"")+"\n          "+(r?'<div class="notification-title-right-text">'+r+"</div>":"")+"\n          "+(s?'<span class="notification-close-button"></span>':"")+'\n        </div>\n        <div class="notification-content">\n          '+(i?'<div class="notification-subtitle">'+i+"</div>":"")+"\n          "+(n?'<div class="notification-text">'+n+"</div>":"")+"\n        </div>\n      </div>\n    ").trim()},t}(Modal),Notification$1={name:"notification",static:{Notification:Notification},create:function(){this.notification=Utils.extend({},ModalMethods({app:this,constructor:Notification,defaultSelector:".notification.modal-in"}))},params:{notification:{icon:null,title:null,titleRightText:null,subtitle:null,text:null,closeButton:!1,closeTimeout:null,closeOnClick:!1,swipeToClose:!0,cssClass:null,render:null}}},Autocomplete=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this;r.app=t;var i,n,s,o=Utils.extend({on:{}},t.params.autocomplete);if(void 0===o.searchbarDisableButton&&(o.searchbarDisableButton="aurora"!==t.theme),r.useModulesParams(o),r.params=Utils.extend(o,a),r.params.openerEl&&(i=$(r.params.openerEl)).length&&(i[0].f7Autocomplete=r),r.params.inputEl&&(n=$(r.params.inputEl)).length&&(n[0].f7Autocomplete=r),r.params.view)s=r.params.view;else if(i||n){var l=i||n;s=l.closest(".view").length&&l.closest(".view")[0].f7View}s||(s=t.views.main);var p=Utils.id(),c=a.url;!c&&i&&i.length&&(i.attr("href")?c=i.attr("href"):i.find("a").length>0&&(c=i.find("a").attr("href"))),c&&"#"!==c&&""!==c||(c=r.params.url);var d=r.params.multiple?"checkbox":"radio";Utils.extend(r,{$openerEl:i,openerEl:i&&i[0],$inputEl:n,inputEl:n&&n[0],id:p,view:s,url:c,value:r.params.value||[],inputType:d,inputName:d+"-"+p,$modalEl:void 0,$dropdownEl:void 0});var u="";function h(){var e=r.$inputEl.val().trim();r.params.source&&r.params.source.call(r,e,function(t){var a,i,s,o="",l=r.params.limit?Math.min(r.params.limit,t.length):t.length;r.items=t,r.params.highlightMatches&&(e=e.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g,"\\$&"),a=new RegExp("("+e+")","i"));for(var p=0;p<l;p+=1){var c="object"==typeof t[p]?t[p][r.params.valueProperty]:t[p],d="object"==typeof t[p]?t[p][r.params.textProperty]:t[p];0===p&&(i=c,s=r.items[p]),o+=r.renderItem({value:c,text:r.params.highlightMatches?d.replace(a,"<b>$1</b>"):d},p)}if(""===o&&""===e&&r.params.dropdownPlaceholderText&&(o+=r.renderItem({placeholder:!0,text:r.params.dropdownPlaceholderText})),r.$dropdownEl.find("ul").html(o),r.params.typeahead){if(!i||!s)return;if(0!==i.toLowerCase().indexOf(e.toLowerCase()))return;if(u.toLowerCase()===e.toLowerCase())return void(r.value=[]);if(0===u.toLowerCase().indexOf(e.toLowerCase()))return u=e,void(r.value=[]);n.val(i),n[0].setSelectionRange(e.length,i.length);var h="object"==typeof r.value[0]?r.value[0][r.params.valueProperty]:r.value[0];h&&i.toLowerCase()===h.toLowerCase()||(r.value=[s],r.emit("local::change autocompleteChange",[s]))}u=e})}function f(){var e,t,a,i=this.value;if($(this).parents(".autocomplete-values").length>0){if("checkbox"===r.inputType&&!this.checked){for(var n=0;n<r.value.length;n+=1)(a="string"==typeof r.value[n]?r.value[n]:r.value[n][r.params.valueProperty])!==i&&1*a!=1*i||r.value.splice(n,1);r.updateValues(),r.emit("local::change autocompleteChange",r.value)}}else{for(var s=0;s<r.items.length;s+=1)(t="object"==typeof r.items[s]?r.items[s][r.params.valueProperty]:r.items[s])!==i&&1*t!=1*i||(e=r.items[s]);if("radio"===r.inputType)r.value=[e];else if(this.checked)r.value.push(e);else for(var o=0;o<r.value.length;o+=1)(a="object"==typeof r.value[o]?r.value[o][r.params.valueProperty]:r.value[o])!==i&&1*a!=1*i||r.value.splice(o,1);r.updateValues(),("radio"===r.inputType&&this.checked||"checkbox"===r.inputType)&&r.emit("local::change autocompleteChange",r.value)}}function v(e){var t=$(e.target);t.is(r.$inputEl[0])||r.$dropdownEl&&t.closest(r.$dropdownEl[0]).length||r.close()}function m(){r.open()}function g(){r.open()}function b(){r.$dropdownEl.find("label.active-state").length>0||setTimeout(function(){r.close()},0)}function y(){r.positionDropdown()}function w(e){if(r.opened){if(27===e.keyCode)return e.preventDefault(),void r.$inputEl.blur();if(13===e.keyCode){var t=r.$dropdownEl.find(".autocomplete-dropdown-selected label");return t.length?(e.preventDefault(),t.trigger("click"),void r.$inputEl.blur()):void(r.params.typeahead&&(e.preventDefault(),r.$inputEl.blur()))}if(40===e.keyCode||38===e.keyCode){e.preventDefault();var a,i=r.$dropdownEl.find(".autocomplete-dropdown-selected");i.length&&(a=i[40===e.keyCode?"next":"prev"]("li")).length||(a=r.$dropdownEl.find("li").eq(40===e.keyCode?0:r.$dropdownEl.find("li").length-1)),a.hasClass("autocomplete-dropdown-placeholder")||(i.removeClass("autocomplete-dropdown-selected"),a.addClass("autocomplete-dropdown-selected"))}}}function C(){for(var e,t=$(this),a=0;a<r.items.length;a+=1){var i="object"==typeof r.items[a]?r.items[a][r.params.valueProperty]:r.items[a],n=t.attr("data-value");i!==n&&1*i!=1*n||(e=r.items[a])}r.params.updateInputValueOnSelect&&(r.$inputEl.val("object"==typeof e?e[r.params.valueProperty]:e),r.$inputEl.trigger("input change")),r.value=[e],r.emit("local::change autocompleteChange",[e]),r.close()}return r.attachEvents=function(){"dropdown"!==r.params.openIn&&r.$openerEl&&r.$openerEl.on("click",m),"dropdown"===r.params.openIn&&r.$inputEl&&(r.$inputEl.on("focus",g),r.$inputEl.on(r.params.inputEvents,h),t.device.android?$("html").on("click",v):r.$inputEl.on("blur",b),r.$inputEl.on("keydown",w))},r.detachEvents=function(){"dropdown"!==r.params.openIn&&r.$openerEl&&r.$openerEl.off("click",m),"dropdown"===r.params.openIn&&r.$inputEl&&(r.$inputEl.off("focus",g),r.$inputEl.off(r.params.inputEvents,h),t.device.android?$("html").off("click",v):r.$inputEl.off("blur",b),r.$inputEl.off("keydown",w))},r.attachDropdownEvents=function(){r.$dropdownEl.on("click","label",C),t.on("resize",y)},r.detachDropdownEvents=function(){r.$dropdownEl.off("click","label",C),t.off("resize",y)},r.attachPageEvents=function(){r.$el.on("change",'input[type="radio"], input[type="checkbox"]',f),r.params.closeOnSelect&&!r.params.multiple&&r.$el.once("click",".list label",function(){Utils.nextTick(function(){r.close()})})},r.detachPageEvents=function(){r.$el.off("change",'input[type="radio"], input[type="checkbox"]',f)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.positionDropdown=function(){var e,t=this,a=t.$inputEl,r=t.app,i=t.$dropdownEl,n=a.parents(".page-content");if(0!==n.length){var s,o=a.offset(),l=a[0].offsetWidth,p=a[0].offsetHeight,c=a.parents(".list");c.parents().each(function(e,t){if(!s){var a=$(t);a.parent(n).length&&(s=a)}});var d,u=c.offset(),h=parseInt(n.css("padding-bottom"),10),f=c.length>0?u.left-n.offset().left:0,v=o.left-(c.length>0?u.left:0)-(r.rtl,0),m=o.top-(n.offset().top-n[0].scrollTop),g=n[0].scrollHeight-h-(m+n[0].scrollTop)-a[0].offsetHeight,b=r.rtl?"padding-right":"padding-left";c.length&&!t.params.expandInput&&(d=(r.rtl?c[0].offsetWidth-v-l:v)-("md"===r.theme?16:15)),i.css({left:(c.length>0?f:v)+"px",top:m+n[0].scrollTop+p+"px",width:(c.length>0?c[0].offsetWidth:l)+"px"}),i.children(".autocomplete-dropdown-inner").css(((e={maxHeight:g+"px"})[b]=c.length>0&&!t.params.expandInput?d+"px":"",e))}},t.prototype.focus=function(){this.$el.find("input[type=search]").focus()},t.prototype.source=function(e){var t=this;if(t.params.source){var a=t.$el;t.params.source.call(t,e,function(r){var i="",n=t.params.limit?Math.min(t.params.limit,r.length):r.length;t.items=r;for(var s=0;s<n;s+=1){for(var o=!1,l="object"==typeof r[s]?r[s][t.params.valueProperty]:r[s],p=0;p<t.value.length;p+=1){var c="object"==typeof t.value[p]?t.value[p][t.params.valueProperty]:t.value[p];c!==l&&1*c!=1*l||(o=!0)}i+=t.renderItem({value:l,text:"object"==typeof r[s]?r[s][t.params.textProperty]:r[s],inputType:t.inputType,id:t.id,inputName:t.inputName,selected:o},s)}a.find(".autocomplete-found ul").html(i),0===r.length?0!==e.length?(a.find(".autocomplete-not-found").show(),a.find(".autocomplete-found, .autocomplete-values").hide()):(a.find(".autocomplete-values").show(),a.find(".autocomplete-found, .autocomplete-not-found").hide()):(a.find(".autocomplete-found").show(),a.find(".autocomplete-not-found, .autocomplete-values").hide())})}},t.prototype.updateValues=function(){for(var e=this,t="",a=0;a<e.value.length;a+=1)t+=e.renderItem({value:"object"==typeof e.value[a]?e.value[a][e.params.valueProperty]:e.value[a],text:"object"==typeof e.value[a]?e.value[a][e.params.textProperty]:e.value[a],inputType:e.inputType,id:e.id,inputName:e.inputName+"-checked}",selected:!0},a);e.$el.find(".autocomplete-values ul").html(t)},t.prototype.preloaderHide=function(){"dropdown"===this.params.openIn&&this.$dropdownEl?this.$dropdownEl.find(".autocomplete-preloader").removeClass("autocomplete-preloader-visible"):$(".autocomplete-preloader").removeClass("autocomplete-preloader-visible")},t.prototype.preloaderShow=function(){"dropdown"===this.params.openIn&&this.$dropdownEl?this.$dropdownEl.find(".autocomplete-preloader").addClass("autocomplete-preloader-visible"):$(".autocomplete-preloader").addClass("autocomplete-preloader-visible")},t.prototype.renderPreloader=function(){return('\n      <div class="autocomplete-preloader preloader '+(this.params.preloaderColor?"color-"+this.params.preloaderColor:"")+'">'+(Utils[this.app.theme+"PreloaderContent"]||"")+"</div>\n    ").trim()},t.prototype.renderSearchbar=function(){var e=this;return e.params.renderSearchbar?e.params.renderSearchbar.call(e):('\n      <form class="searchbar">\n        <div class="searchbar-inner">\n          <div class="searchbar-input-wrap">\n            <input type="search" placeholder="'+e.params.searchbarPlaceholder+'"/>\n            <i class="searchbar-icon"></i>\n            <span class="input-clear-button"></span>\n          </div>\n          '+(e.params.searchbarDisableButton?'\n          <span class="searchbar-disable-button">'+e.params.searchbarDisableText+"</span>\n          ":"")+"\n        </div>\n      </form>\n    ").trim()},t.prototype.renderItem=function(e,t){if(this.params.renderItem)return this.params.renderItem.call(this,e,t);var a=e.value&&"string"==typeof e.value?e.value.replace(/"/g,"&quot;"):e.value;return("dropdown"!==this.params.openIn?'\n        <li>\n          <label class="item-'+e.inputType+' item-content">\n            <input type="'+e.inputType+'" name="'+e.inputName+'" value="'+a+'" '+(e.selected?"checked":"")+'>\n            <i class="icon icon-'+e.inputType+'"></i>\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ":e.placeholder?'\n        <li class="autocomplete-dropdown-placeholder">\n          <label class="item-content">\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ":'\n        <li>\n          <label class="item-radio item-content" data-value="'+a+'">\n            <div class="item-inner">\n              <div class="item-title">'+e.text+"</div>\n            </div>\n          </label>\n        </li>\n      ").trim()},t.prototype.renderNavbar=function(){var e=this;if(e.params.renderNavbar)return e.params.renderNavbar.call(e);var t=e.params.pageTitle;void 0===t&&e.$openerEl&&e.$openerEl.length&&(t=e.$openerEl.find(".item-title").text().trim());var a="popup"===e.params.openIn,r=a?"\n        "+(e.params.preloader?'\n        <div class="left">\n          '+e.renderPreloader()+"\n        </div>\n        ":"")+"\n      ":'\n        <div class="left sliding">\n          <a class="link back">\n            <i class="icon icon-back"></i>\n            <span class="if-not-md">'+e.params.pageBackLinkText+"</span>\n          </a>\n        </div>\n      ",i=a?'\n        <div class="right">\n          <a class="link popup-close" data-popup=".autocomplete-popup">\n            '+e.params.popupCloseLinkText+"\n          </a>\n        </div>\n      ":"\n        "+(e.params.preloader?'\n        <div class="right">\n          '+e.renderPreloader()+"\n        </div>\n        ":"")+"\n      ";return('\n      <div class="navbar '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n        <div class="navbar-inner '+(e.params.navbarColorTheme?"color-"+e.params.navbarColorTheme:"")+'">\n          '+r+"\n          "+(t?'<div class="title sliding">'+t+"</div>":"")+"\n          "+i+'\n          <div class="subnavbar sliding">'+e.renderSearchbar()+"</div>\n        </div>\n      </div>\n    ").trim()},t.prototype.renderDropdown=function(){var e=this;return e.params.renderDropdown?e.params.renderDropdown.call(e,e.items):('\n      <div class="autocomplete-dropdown">\n        <div class="autocomplete-dropdown-inner">\n          <div class="list '+(e.params.expandInput?"":"no-safe-areas")+'">\n            <ul></ul>\n          </div>\n        </div>\n        '+(e.params.preloader?e.renderPreloader():"")+"\n      </div>\n    ").trim()},t.prototype.renderPage=function(e){var t=this;return t.params.renderPage?t.params.renderPage.call(t,t.items):('\n      <div class="page page-with-subnavbar autocomplete-page" data-name="autocomplete-page">\n        '+t.renderNavbar(e)+'\n        <div class="searchbar-backdrop"></div>\n        <div class="page-content">\n          <div class="list autocomplete-list autocomplete-found autocomplete-list-'+t.id+" "+(t.params.formColorTheme?"color-"+t.params.formColorTheme:"")+'">\n            <ul></ul>\n          </div>\n          <div class="list autocomplete-not-found">\n            <ul>\n              <li class="item-content"><div class="item-inner"><div class="item-title">'+t.params.notFoundText+'</div></div></li>\n            </ul>\n          </div>\n          <div class="list autocomplete-values">\n            <ul></ul>\n          </div>\n        </div>\n      </div>\n    ').trim()},t.prototype.renderPopup=function(){var e=this;return e.params.renderPopup?e.params.renderPopup.call(e,e.items):('\n      <div class="popup autocomplete-popup">\n        <div class="view">\n          '+e.renderPage(!0)+";\n        </div>\n      </div>\n    ").trim()},t.prototype.onOpen=function(e,t){var a=this,r=a.app,i=$(t);if(a.$el=i,a.el=i[0],a.openedIn=e,a.opened=!0,"dropdown"===a.params.openIn)a.attachDropdownEvents(),a.$dropdownEl.addClass("autocomplete-dropdown-in"),a.$inputEl.trigger("input");else{var n=i.find(".searchbar");"page"===a.params.openIn&&"ios"===r.theme&&0===n.length&&(n=$(r.navbar.getElByPage(i)).find(".searchbar")),a.searchbar=r.searchbar.create({el:n,backdropEl:i.find(".searchbar-backdrop"),customSearch:!0,on:{search:function(e,t){0===t.length&&a.searchbar.enabled?a.searchbar.backdropShow():a.searchbar.backdropHide(),a.source(t)}}}),a.attachPageEvents(),a.updateValues(),a.params.requestSourceOnOpen&&a.source("")}a.emit("local::open autocompleteOpen",a)},t.prototype.autoFocus=function(){return this.searchbar&&this.searchbar.$inputEl&&this.searchbar.$inputEl.focus(),this},t.prototype.onOpened=function(){var e=this;"dropdown"!==e.params.openIn&&e.params.autoFocus&&e.autoFocus(),e.emit("local::opened autocompleteOpened",e)},t.prototype.onClose=function(){var e=this;e.destroyed||(e.searchbar&&e.searchbar.destroy&&(e.searchbar.destroy(),e.searchbar=null,delete e.searchbar),"dropdown"===e.params.openIn?(e.detachDropdownEvents(),e.$dropdownEl.removeClass("autocomplete-dropdown-in").remove(),e.$inputEl.parents(".item-content-dropdown-expanded").removeClass("item-content-dropdown-expanded")):e.detachPageEvents(),e.emit("local::close autocompleteClose",e))},t.prototype.onClosed=function(){var e=this;e.destroyed||(e.opened=!1,e.$el=null,e.el=null,delete e.$el,delete e.el,e.emit("local::closed autocompleteClosed",e))},t.prototype.openPage=function(){var e=this;if(e.opened)return e;var t=e.renderPage();return e.view.router.navigate({url:e.url,route:{content:t,path:e.url,on:{pageBeforeIn:function(t,a){e.onOpen("page",a.el)},pageAfterIn:function(t,a){e.onOpened("page",a.el)},pageBeforeOut:function(t,a){e.onClose("page",a.el)},pageAfterOut:function(t,a){e.onClosed("page",a.el)}},options:{animate:e.params.animate}}}),e},t.prototype.openPopup=function(){var e=this;if(e.opened)return e;var t={content:e.renderPopup(),animate:e.params.animate,on:{popupOpen:function(t){e.onOpen("popup",t.el)},popupOpened:function(t){e.onOpened("popup",t.el)},popupClose:function(t){e.onClose("popup",t.el)},popupClosed:function(t){e.onClosed("popup",t.el)}}};return e.params.routableModals?e.view.router.navigate({url:e.url,route:{path:e.url,popup:t}}):e.modal=e.app.popup.create(t).open(e.params.animate),e},t.prototype.openDropdown=function(){var e=this;e.$dropdownEl||(e.$dropdownEl=$(e.renderDropdown())),e.$inputEl.parents(".list").length&&e.$inputEl.parents(".item-content").length>0&&e.params.expandInput&&e.$inputEl.parents(".item-content").addClass("item-content-dropdown-expanded");var t=e.$inputEl.parents(".page-content");e.params.dropdownContainerEl?$(e.params.dropdownContainerEl).append(e.$dropdownEl):0===t.length?e.$dropdownEl.insertAfter(e.$inputEl):(e.positionDropdown(),t.append(e.$dropdownEl)),e.onOpen("dropdown",e.$dropdownEl),e.onOpened("dropdown",e.$dropdownEl)},t.prototype.open=function(){var e=this;return e.opened?e:(e["open"+e.params.openIn.split("").map(function(e,t){return 0===t?e.toUpperCase():e}).join("")](),e)},t.prototype.close=function(){var e=this;return e.opened?("dropdown"===e.params.openIn?(e.onClose(),e.onClosed()):e.params.routableModals||"page"===e.openedIn?e.view.router.back({animate:e.params.animate}):(e.modal.once("modalClosed",function(){Utils.nextTick(function(){e.destroyed||(e.modal.destroy(),delete e.modal)})}),e.modal.close()),e):e},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){var e=this;e.emit("local::beforeDestroy autocompleteBeforeDestroy",e),e.detachEvents(),e.$inputEl&&e.$inputEl[0]&&delete e.$inputEl[0].f7Autocomplete,e.$openerEl&&e.$openerEl[0]&&delete e.$openerEl[0].f7Autocomplete,Utils.deleteProps(e),e.destroyed=!0},t}(Framework7Class),Autocomplete$1={name:"autocomplete",params:{autocomplete:{openerEl:void 0,inputEl:void 0,view:void 0,dropdownContainerEl:void 0,dropdownPlaceholderText:void 0,typeahead:!1,highlightMatches:!0,expandInput:!1,updateInputValueOnSelect:!0,inputEvents:"input",value:void 0,multiple:!1,source:void 0,limit:void 0,valueProperty:"id",textProperty:"text",openIn:"page",pageBackLinkText:"Back",popupCloseLinkText:"Close",pageTitle:void 0,searchbarPlaceholder:"Search...",searchbarDisableText:"Cancel",searchbarDisableButton:void 0,animate:!0,autoFocus:!1,closeOnSelect:!1,notFoundText:"Nothing found",requestSourceOnOpen:!1,preloaderColor:void 0,preloader:!1,formColorTheme:void 0,navbarColorTheme:void 0,routableModals:!0,url:"select/",renderDropdown:void 0,renderPage:void 0,renderPopup:void 0,renderItem:void 0,renderSearchbar:void 0,renderNavbar:void 0}},static:{Autocomplete:Autocomplete},create:function(){var e=this;e.autocomplete=Utils.extend(ConstructorMethods({defaultSelector:void 0,constructor:Autocomplete,app:e,domProp:"f7Autocomplete"}),{open:function(t){var a=e.autocomplete.get(t);if(a&&a.open)return a.open()},close:function(t){var a=e.autocomplete.get(t);if(a&&a.close)return a.close()}})}},Tooltip=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=this,i=Utils.extend({},t.params.tooltip);r.useModulesParams(i),r.params=Utils.extend(i,a);var n=r.params.targetEl;if(!n)return r;var s=$(n);if(0===s.length)return r;if(s[0].f7Tooltip)return s[0].f7Tooltip;var o=$(r.render()).eq(0);Utils.extend(r,{app:t,$targetEl:s,targetEl:s&&s[0],$el:o,el:o&&o[0],text:r.params.text||"",visible:!1,opened:!1}),s[0].f7Tooltip=r;var l,p={};function c(e){l||(l=!0,p.x="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,p.y="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,r.show(this))}function d(e){if(l){var t="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,a="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY;Math.pow(Math.pow(t-p.x,2)+Math.pow(a-p.y,2),.5)>50&&(l=!1,r.hide())}}function u(){l&&(l=!1,r.hide())}function h(){r.show(this)}function f(){r.hide()}function v(){o.hasClass("tooltip-in")||o.removeClass("tooltip-out").remove()}return r.attachEvents=function(){if(o.on("transitionend",v),Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.on(t.touchEvents.start,c,e),t.on("touchmove",d),t.on("touchend:passive",u)}else s.on("mouseenter",h),s.on("mouseleave",f)},r.detachEvents=function(){if(o.off("transitionend",v),Support.touch){var e=!!Support.passiveListener&&{passive:!0};s.off(t.touchEvents.start,c,e),t.off("touchmove",d),t.off("touchend:passive",u)}else s.off("mouseenter",h),s.off("mouseleave",f)},r.useModules(),r.init(),r}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.position=function(e){var t=this.$el,a=this.app;t.css({left:"",top:""});var r,i,n,s,o=$(e||this.targetEl),l=[t.width(),t.height()],p=l[0],c=l[1];if(t.css({left:"",top:""}),o&&o.length>0){r=o.outerWidth(),i=o.outerHeight();var d=o.offset();n=d.left-a.left,s=d.top-a.top;var u=o.parents(".page");u.length>0&&(s-=u[0].scrollTop)}var h=[0,0,0],f=h[0],v=h[1],m="top";c<s?v=s-c:c<a.height-s-i?(m="bottom",v=s+i):(m="middle",(v=i/2+s-c/2)<=0?v=8:v+c>=a.height&&(v=a.height-c-8)),"top"===m||"bottom"===m?((f=r/2+n-p/2)<8&&(f=8),f+p>a.width&&(f=a.width-p-8),f<0&&(f=0)):"middle"===m&&((f=n-p)<8||f+p>a.width)&&(f<8&&(f=n+r),f+p>a.width&&(f=a.width-p-8)),t.css({top:v+"px",left:f+"px"})},t.prototype.show=function(e){var t=this.app,a=this.$el,r=this.$targetEl;t.root.append(a),this.position(e);var i=$(e);return this.visible=!0,this.opened=!0,r.trigger("tooltip:show",this),a.trigger("tooltip:show",this),i.length&&i[0]!==r[0]&&i.trigger("tooltip:show",this),this.emit("local::show tooltipShow",this),a.removeClass("tooltip-out").addClass("tooltip-in"),this},t.prototype.hide=function(){var e=this.$el,t=this.$targetEl;return this.visible=!1,this.opened=!1,t.trigger("tooltip:hide",this),e.trigger("tooltip:hide",this),this.emit("local::hide tooltipHide",this),e.addClass("tooltip-out").removeClass("tooltip-in"),this},t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params;return('\n      <div class="tooltip '+(e.cssClass||"")+'">\n        <div class="tooltip-content">'+(e.text||"")+"</div>\n      </div>\n    ").trim()},t.prototype.setText=function(e){return void 0===e?this:(this.params.text=e,this.text=e,this.$el&&this.$el.children(".tooltip-content").html(e),this.opened&&this.position(),this)},t.prototype.init=function(){this.attachEvents()},t.prototype.destroy=function(){this.$targetEl&&!this.destroyed&&(this.$targetEl.trigger("tooltip:beforedestroy",this),this.emit("local::beforeDestroy tooltipBeforeDestroy",this),this.$el.remove(),delete this.$targetEl[0].f7Tooltip,this.detachEvents(),Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),Tooltip$1={name:"tooltip",static:{Tooltip:Tooltip},create:function(){this.tooltip=ConstructorMethods({defaultSelector:".tooltip",constructor:Tooltip,app:this,domProp:"f7Tooltip"}),this.tooltip.show=function(e){var t=$(e);if(0!==t.length){var a=t[0].f7Tooltip;if(a)return a.show(t[0]),a}},this.tooltip.hide=function(e){var t=$(e);if(0!==t.length){var a=t[0].f7Tooltip;if(a)return a.hide(),a}},this.tooltip.setText=function(e,t){var a=$(e);if(0!==a.length){var r=a[0].f7Tooltip;if(r)return r.setText(t),r}}},params:{tooltip:{targetEl:null,text:null,cssClass:null,render:null}},on:{tabMounted:function(e){var t=this;$(e).find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})})},tabBeforeRemove:function(e){$(e).find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()})},pageInit:function(e){var t=this;e.$el.find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})}),"ios"===t.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".tooltip-init").each(function(e,a){var r=$(a).attr("data-tooltip");r&&t.tooltip.create({targetEl:a,text:r})})},pageBeforeRemove:function(e){e.$el.find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()}),"ios"===this.theme&&e.view&&e.view.router.separateNavbar&&e.$navbarEl&&e.$navbarEl.length>0&&e.$navbarEl.find(".tooltip-init").each(function(e,t){t.f7Tooltip&&t.f7Tooltip.destroy()})}},vnode:{"tooltip-init":{insert:function(e){var t=e.elm,a=$(t).attr("data-tooltip");a&&this.tooltip.create({targetEl:t,text:a})},update:function(e){var t=e.elm;t.f7Tooltip&&e&&e.data&&e.data.attrs&&e.data.attrs["data-tooltip"]&&t.f7Tooltip.setText(e.data.attrs["data-tooltip"])},destroy:function(e){var t=e.elm;t.f7Tooltip&&t.f7Tooltip.destroy()}}}},Gauge=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r=Utils.extend({},t.params.gauge);this.useModulesParams(r),this.params=Utils.extend(r,a);var i=this.params.el;if(!i)return this;var n=$(i);return 0===n.length?this:n[0].f7Gauge?n[0].f7Gauge:(Utils.extend(this,{app:t,$el:n,el:n&&n[0]}),n[0].f7Gauge=this,this.useModules(),this.init(),this)}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.calcRadius=function(){var e=this.params;return e.size/2-e.borderWidth/2},t.prototype.calcBorderLength=function(){var e=this.calcRadius();return 2*Math.PI*e},t.prototype.render=function(){if(this.params.render)return this.params.render.call(this,this);var e=this.params,t=e.type,a=e.value,r=e.size,i=e.bgColor,n=e.borderBgColor,s=e.borderColor,o=e.borderWidth,l=e.valueText,p=e.valueTextColor,c=e.valueFontSize,d=e.valueFontWeight,u=e.labelText,h=e.labelTextColor,f=e.labelFontSize,v=e.labelFontWeight,m="semicircle"===t,g=this.calcRadius(),b=this.calcBorderLength(),y=Math.max(Math.min(a,1),0);return('\n      <svg class="gauge-svg" width="'+r+'px" height="'+(m?r/2:r)+'px" viewBox="0 0 '+r+" "+(m?r/2:r)+'">\n        '+(m?'\n          <path\n            class="gauge-back-semi"\n            d="M'+(r-o/2)+","+r/2+" a1,1 0 0,0 -"+(r-o)+',0"\n            stroke="'+n+'"\n            stroke-width="'+o+'"\n            fill="'+(i||"none")+'"\n          />\n          <path\n            class="gauge-front-semi"\n            d="M'+(r-o/2)+","+r/2+" a1,1 0 0,0 -"+(r-o)+',0"\n            stroke="'+s+'"\n            stroke-width="'+o+'"\n            stroke-dasharray="'+b/2+'"\n            stroke-dashoffset="'+b/2*(1+y)+'"\n            fill="'+(n?"none":i||"none")+'"\n          />\n        ':"\n          "+(n?'\n            <circle\n              class="gauge-back-circle"\n              stroke="'+n+'"\n              stroke-width="'+o+'"\n              fill="'+(i||"none")+'"\n              cx="'+r/2+'"\n              cy="'+r/2+'"\n              r="'+g+'"\n            ></circle>\n          ':"")+'\n          <circle\n            class="gauge-front-circle"\n            transform="rotate(-90 '+r/2+" "+r/2+')"\n            stroke="'+s+'"\n            stroke-width="'+o+'"\n            stroke-dasharray="'+b+'"\n            stroke-dashoffset="'+b*(1-y)+'"\n            fill="'+(n?"none":i||"none")+'"\n            cx="'+r/2+'"\n            cy="'+r/2+'"\n            r="'+g+'"\n          ></circle>\n        ')+"\n        "+(l?'\n          <text\n            class="gauge-value-text"\n            x="50%"\n            y="'+(m?"100%":"50%")+'"\n            font-weight="'+d+'"\n            font-size="'+c+'"\n            fill="'+p+'"\n            dy="'+(m?u?-f-15:-5:0)+'"\n            text-anchor="middle"\n            dominant-baseline="'+(!m&&"middle")+'"\n          >'+l+"</text>\n        ":"")+"\n        "+(u?'\n          <text\n            class="gauge-label-text"\n            x="50%"\n            y="'+(m?"100%":"50%")+'"\n            font-weight="'+v+'"\n            font-size="'+f+'"\n            fill="'+h+'"\n            dy="'+(m?-5:l?c/2+10:0)+'"\n            text-anchor="middle"\n            dominant-baseline="'+(!m&&"middle")+'"\n          >'+u+"</text>\n        ":"")+"\n      </svg>\n    ").trim()},t.prototype.update=function(e){void 0===e&&(e={});var t=this.params,a=this.$gaugeSvgEl;if(Object.keys(e).forEach(function(a){void 0!==e[a]&&(t[a]=e[a])}),0===a.length)return this;var r=t.value,i=t.size,n=t.bgColor,s=t.borderBgColor,o=t.borderColor,l=t.borderWidth,p=t.valueText,c=t.valueTextColor,d=t.valueFontSize,u=t.valueFontWeight,h=t.labelText,f=t.labelTextColor,v=t.labelFontSize,m=t.labelFontWeight,g=this.calcBorderLength(),b=Math.max(Math.min(r,1),0),y=this.calcRadius(),w="semicircle"===t.type,C={width:i+"px",height:(w?i/2:i)+"px",viewBox:"0 0 "+i+" "+(w?i/2:i)};if(Object.keys(C).forEach(function(e){a.attr(e,C[e])}),w){var x={d:"M"+(i-l/2)+","+i/2+" a1,1 0 0,0 -"+(i-l)+",0",stroke:s,"stroke-width":l,fill:n||"none"},$={d:"M"+(i-l/2)+","+i/2+" a1,1 0 0,0 -"+(i-l)+",0",stroke:o,"stroke-width":l,"stroke-dasharray":g/2,"stroke-dashoffset":g/2*(b-1),fill:s?"none":n||"none"};Object.keys(x).forEach(function(e){a.find(".gauge-back-semi").attr(e,x[e])}),Object.keys($).forEach(function(e){a.find(".gauge-front-semi").attr(e,$[e])})}else{var k={stroke:s,"stroke-width":l,fill:n||"none",cx:i/2,cy:i/2,r:y},E={transform:"rotate(-90 "+i/2+" "+i/2+")",stroke:o,"stroke-width":l,"stroke-dasharray":g,"stroke-dashoffset":g*(1-b),fill:s?"none":n||"none",cx:i/2,cy:i/2,r:y};Object.keys(k).forEach(function(e){a.find(".gauge-back-circle").attr(e,k[e])}),Object.keys(E).forEach(function(e){a.find(".gauge-front-circle").attr(e,E[e])})}if(p){a.find(".gauge-value-text").length||a.append('<text class="gauge-value-text"></text>');var S={x:"50%",y:w?"100%":"50%","font-weight":u,"font-size":d,fill:c,dy:w?h?-v-15:-5:0,"text-anchor":"middle","dominant-baseline":!w&&"middle"};Object.keys(S).forEach(function(e){a.find(".gauge-value-text").attr(e,S[e])}),a.find(".gauge-value-text").text(p)}else a.find(".gauge-value-text").remove();if(h){a.find(".gauge-label-text").length||a.append('<text class="gauge-label-text"></text>');var T={x:"50%",y:w?"100%":"50%","font-weight":m,"font-size":v,fill:f,dy:w?-5:p?d/2+10:0,"text-anchor":"middle","dominant-baseline":!w&&"middle"};Object.keys(T).forEach(function(e){a.find(".gauge-label-text").attr(e,T[e])}),a.find(".gauge-label-text").text(h)}else a.find(".gauge-label-text").remove();return this},t.prototype.init=function(){var e=$(this.render()).eq(0);return e.f7Gauge=this,Utils.extend(this,{$gaugeSvgEl:e,gaugeSvgEl:e&&e[0]}),this.$el.append(e),this},t.prototype.destroy=function(){this.$el&&!this.destroyed&&(this.$el.trigger("gauge:beforedestroy",this),this.emit("local::beforeDestroy gaugeBeforeDestroy",this),this.$gaugeSvgEl.remove(),delete this.$el[0].f7Gauge,Utils.deleteProps(this),this.destroyed=!0)},t}(Framework7Class),Gauge$1={name:"gauge",static:{Gauge:Gauge},create:function(){var e=this;e.gauge=ConstructorMethods({defaultSelector:".gauge",constructor:Gauge,app:e,domProp:"f7Gauge"}),e.gauge.update=function(t,a){if(0!==$(t).length){var r=e.gauge.get(t);if(r)return r.update(a),r}}},params:{gauge:{el:null,type:"circle",value:0,size:200,bgColor:"transparent",borderBgColor:"#eeeeee",borderColor:"#000000",borderWidth:10,valueText:null,valueTextColor:"#000000",valueFontSize:31,valueFontWeight:500,labelText:null,labelTextColor:"#888888",labelFontSize:14,labelFontWeight:400}},on:{tabMounted:function(e){var t=this;$(e).find(".gauge-init").each(function(e,a){t.gauge.create(Utils.extend({el:a},$(a).dataset()||{}))})},tabBeforeRemove:function(e){$(e).find(".gauge-init").each(function(e,t){t.f7Gauge&&t.f7Gauge.destroy()})},pageInit:function(e){var t=this;e.$el.find(".gauge-init").each(function(e,a){t.gauge.create(Utils.extend({el:a},$(a).dataset()||{}))})},pageBeforeRemove:function(e){e.$el.find(".gauge-init").each(function(e,t){t.f7Gauge&&t.f7Gauge.destroy()})}},vnode:{"gauge-init":{insert:function(e){var t=e.elm;this.gauge.create(Utils.extend({el:t},$(t).dataset()||{}))},destroy:function(e){var t=e.elm;t.f7Gauge&&t.f7Gauge.destroy()}}}},Skeleton={name:"skeleton"},Menu={open:function(e){void 0===e&&(e=".menu-item-dropdown");if(e){var t=$(e).closest(".menu-item-dropdown");if(t.length){var a=t.closest(".menu").eq(0);if(a.length){var r=a.css("z-index"),i=a[0].style.zIndex;a.css("z-index",parseInt(r||0,0)+1),a[0].f7MenuZIndex=i}t.eq(0).addClass("menu-item-dropdown-opened").trigger("menu:opened"),this.emit("menuOpened",t.eq(0)[0])}}},close:function(e){void 0===e&&(e=".menu-item-dropdown-opened");if(e){var t=$(e).closest(".menu-item-dropdown-opened");if(t.length){var a=t.closest(".menu").eq(0);if(a.length){var r=a[0].f7MenuZIndex;a.css("z-index",r),delete a[0].f7MenuZIndex}t.eq(0).removeClass("menu-item-dropdown-opened").trigger("menu:closed"),this.emit("menuClosed",t.eq(0)[0])}}}},Menu$1={name:"menu",create:function(){this.menu={open:Menu.open.bind(this),close:Menu.close.bind(this)}},on:{click:function(e){var t=this,a=$(".menu-item-dropdown-opened");a.length&&a.each(function(a,r){$(e.target).closest(".menu-item-dropdown-opened").length||t.menu.close(r)})}},clicks:{".menu-item-dropdown":function(e,t,a){if(e.hasClass("menu-item-dropdown-opened")){if($(a.target).closest(".menu-dropdown").length)return;this.menu.close(e)}else this.menu.open(e)},".menu-close":function(){this.menu.close()}}},moduleAlphaSlider={render:function(e){var t=e.params,a=t.sliderLabel,r=t.sliderValue,i=t.sliderValueEditable,n=t.alphaLabelText;return'\n      <div class="color-picker-module color-picker-module-alpha-slider">\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-alpha"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.01" min="0" max="1" class="color-picker-value-alpha">\n              ':'\n                <span class="color-picker-value-alpha"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=e.value.alpha,r=parseFloat(t.target.value);Number.isNaN(r)?t.target.value=a:(r=Math.max(0,Math.min(1,r)),e.setValue({alpha:r}))}e.alphaRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-alpha"),min:0,max:1,step:.01,value:1,on:{change:function(t,a){var r=Math.floor(100*a)/100;e.setValue({alpha:r})}}}),e.$el.on("change",".color-picker-module-alpha-slider input",t),e.destroyAlphaSliderEvents=function(){e.$el.off("change",".color-picker-module-alpha-slider input",t)}},update:function(e){var t=e.value,a=e.params,r=a.sliderValue,i=a.sliderValueEditable,n=t.alpha;e.alphaRangeSlider.value=n,e.alphaRangeSlider.layout(),r&&i?e.$el.find("input.color-picker-value-alpha").val(n):e.$el.find("span.color-picker-value-alpha").text(n)},destroy:function(e){e.alphaRangeSlider&&e.alphaRangeSlider.destroy&&e.alphaRangeSlider.destroy(),delete e.alphaRangeSlider,e.destroyAlphaSliderEvents&&e.destroyAlphaSliderEvents(),delete e.destroyAlphaSliderEvents}},moduleCurrentColor={render:function(){return'\n      <div class="color-picker-module color-picker-module-current-color">\n        <div class="color-picker-current-color"></div>\n      </div>\n    '},update:function(e){e.$el.find(".color-picker-module-current-color .color-picker-current-color").css("background-color",e.value.hex)}},moduleHex={render:function(e){var t=e.params,a=t.hexLabel,r=t.hexLabelText;return'\n      <div class="color-picker-module color-picker-module-hex">\n        <div class="color-picker-hex-wrap">\n          '+(a?'\n            <div class="color-picker-hex-label">'+r+"</div>\n          ":"")+'\n          <div class="color-picker-hex-value">\n            '+(t.hexValueEditable?'\n              <input type="text" class="color-picker-value-hex">\n            ':'\n              <span class="color-picker-value-hex"></span>\n            ')+"\n          </div>\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=e.value.hex,r=t.target.value.replace(/#/g,"");if(Number.isNaN(r)||!r||3!==r.length&&6!==r.length)t.target.value=a;else{var i=parseInt(r,16);i>parseInt("ffffff",16)&&(r="fff"),i<0&&(r="000"),e.setValue({hex:r})}}e.$el.on("change",".color-picker-module-hex input",t),e.destroyHexEvents=function(){e.$el.off("change",".color-picker-module-hex input",t)}},update:function(e){var t=e.value,a=e.params.hexValueEditable,r=t.hex;a?e.$el.find("input.color-picker-value-hex").val(r):e.$el.find("span.color-picker-value-hex").text(r)},destroy:function(e){e.destroyHexEvents&&e.destroyHexEvents(),delete e.destroyHexEvents}},moduleHsbSliders={render:function(e){var t=e.params,a=t.sliderLabel,r=t.sliderValue,i=t.sliderValueEditable,n=t.hueLabelText,s=t.saturationLabelText,o=t.brightnessLabelText;return'\n      <div class="color-picker-module color-picker-module-hsb-sliders">\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-hue"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.1" min="0" max="360" class="color-picker-value-hue" data-color-index="0">\n              ':'\n                <span class="color-picker-value-hue"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+s+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-saturation"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.1" min="0" max="100" class="color-picker-value-saturation" data-color-index="1">\n              ':'\n                <span class="color-picker-value-saturation"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+o+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-brightness"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.1" min="0" max="100" class="color-picker-value-brightness" data-color-index="2">\n              ':'\n                <span class="color-picker-value-brightness"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=[].concat(e.value.hsb),r=parseInt($(t.target).attr("data-color-index"),10),i=parseFloat(t.target.value);Number.isNaN(i)?t.target.value=a[r]:(i=0===r?Math.max(0,Math.min(360,i)):Math.max(0,Math.min(100,i))/100,a[r]=i,e.setValue({hsb:a}))}e.hueRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-hue"),min:0,max:360,step:.1,value:0,on:{change:function(t,a){e.setValue({hue:a})}}}),e.saturationRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-saturation"),min:0,max:1,step:.001,value:0,on:{change:function(t,a){var r=Math.floor(1e3*a)/1e3;e.setValue({hsb:[e.value.hsb[0],r,e.value.hsb[2]]})}}}),e.brightnessRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-brightness"),min:0,max:1,step:.001,value:0,on:{change:function(t,a){var r=Math.floor(1e3*a)/1e3;e.setValue({hsb:[e.value.hsb[0],e.value.hsb[1],r]})}}}),e.$el.on("change",".color-picker-module-hsb-sliders input",t),e.destroyHsbSlidersEvents=function(){e.$el.off("change",".color-picker-module-hsb-sliders input",t)}},update:function(e){var t=e.app,a=e.value,r=e.params,i=r.sliderValue,n=r.sliderValueEditable,s=a.hsb,o=a.hue;e.hueRangeSlider.value=o,e.saturationRangeSlider.value=s[1],e.brightnessRangeSlider.value=s[2],e.hueRangeSlider.layout(),e.saturationRangeSlider.layout(),e.brightnessRangeSlider.layout();var l=Utils.colorHsbToHsl(s[0],s[1],1),p=Utils.colorHsbToHsl(s[0],0,1),c=Utils.colorHsbToHsl(s[0],1,1),d=s[2];e.hueRangeSlider.$el[0].style.setProperty("--f7-range-knob-color","hsl("+o+", 100%, 50%)"),e.saturationRangeSlider.$el[0].style.setProperty("--f7-range-knob-color","hsl("+l[0]+", "+100*l[1]+"%, "+100*l[2]+"%)"),e.brightnessRangeSlider.$el[0].style.setProperty("--f7-range-knob-color","rgb("+255*d+", "+255*d+", "+255*d+")"),e.saturationRangeSlider.$el.find(".range-bar").css("background-image","linear-gradient("+(t.rtl?"to left":"to right")+", hsl("+p[0]+", "+100*p[1]+"%, "+100*p[2]+"%), hsl("+c[0]+", "+100*c[1]+"%, "+100*c[2]+"%))"),i&&n?(e.$el.find("input.color-picker-value-hue").val(""+o),e.$el.find("input.color-picker-value-saturation").val(""+1e3*s[1]/10),e.$el.find("input.color-picker-value-brightness").val(""+1e3*s[2]/10)):i&&(e.$el.find("span.color-picker-value-hue").text(""+o),e.$el.find("span.color-picker-value-saturation").text(""+1e3*s[1]/10),e.$el.find("span.color-picker-value-brightness").text(""+1e3*s[2]/10))},destroy:function(e){e.hueRangeSlider&&e.hueRangeSlider.destroy&&e.hueRangeSlider.destroy(),e.saturationRangeSlider&&e.saturationRangeSlider.destroy&&e.saturationRangeSlider.destroy(),e.brightnessRangeSlider&&e.brightnessRangeSlider.destroy&&e.brightnessRangeSlider.destroy(),delete e.hueRangeSlider,delete e.saturationRangeSlider,delete e.brightnessRangeSlider,e.destroyHsbSlidersEvents&&e.destroyHsbSlidersEvents(),delete e.destroyHsbSlidersEvents}},moduleHueSlider={render:function(e){var t=e.params,a=t.sliderLabel,r=t.sliderValue,i=t.sliderValueEditable,n=t.hueLabelText;return'\n      <div class="color-picker-module color-picker-module-hue-slider">\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-hue"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.1" min="0" max="360" class="color-picker-value-hue">\n              ':'\n                <span class="color-picker-value-hue"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){e.hueRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-hue"),min:0,max:360,step:.1,value:0,on:{change:function(t,a){e.setValue({hue:a})}}})},update:function(e){var t=e.value,a=e.params,r=a.sliderValue,i=a.sliderValueEditable,n=t.hue;e.hueRangeSlider.value=n,e.hueRangeSlider.layout(),e.hueRangeSlider.$el[0].style.setProperty("--f7-range-knob-color","hsl("+n+", 100%, 50%)"),r&&i?e.$el.find("input.color-picker-value-hue").val(""+n):r&&e.$el.find("span.color-picker-value-hue").text(""+n)},destroy:function(e){e.hueRangeSlider&&e.hueRangeSlider.destroy&&e.hueRangeSlider.destroy(),delete e.hueRangeSlider}},moduleBrightnessSlider={render:function(e){var t=e.params,a=t.sliderLabel,r=t.sliderValue,i=t.sliderValueEditable,n=t.brightnessLabelText;return'\n      <div class="color-picker-module color-picker-module-brightness-slider">\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-brightness"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="0.1" min="0" max="100" class="color-picker-value-brightness">\n              ':'\n                <span class="color-picker-value-brightness"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){e.brightnessRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-brightness"),min:0,max:1,step:.001,value:0,on:{change:function(t,a){var r=Math.floor(1e3*a)/1e3;e.setValue({hsb:[e.value.hsb[0],e.value.hsb[1],r]})}}})},update:function(e){var t=e.value,a=e.app,r=e.params,i=r.sliderValue,n=r.sliderValueEditable,s=t.hsb;e.brightnessRangeSlider.value=s[2],e.brightnessRangeSlider.layout();var o=Utils.colorHsbToHsl(s[0],s[1],s[2]),l=Utils.colorHsbToHsl(s[0],s[1],0),p=Utils.colorHsbToHsl(s[0],s[1],1);e.brightnessRangeSlider.$el[0].style.setProperty("--f7-range-knob-color","hsl("+o[0]+", "+100*o[1]+"%, "+100*o[2]+"%)"),e.brightnessRangeSlider.$el.find(".range-bar").css("background-image","linear-gradient("+(a.rtl?"to left":"to right")+", hsl("+l[0]+", "+100*l[1]+"%, "+100*l[2]+"%), hsl("+p[0]+", "+100*p[1]+"%, "+100*p[2]+"%))"),i&&n?e.$el.find("input.color-picker-value-brightness").val(""+1e3*s[2]/10):i&&e.$el.find("span.color-picker-value-brightness").text(""+1e3*s[2]/10)},destroy:function(e){e.brightnessRangeSlider&&e.brightnessRangeSlider.destroy&&e.brightnessRangeSlider.destroy(),delete e.brightnessRangeSlider}},modulePalette={render:function(e){return'\n      <div class="color-picker-module color-picker-module-palette">\n        <div class="color-picker-palette">\n          '+e.params.palette.map(function(e){if(Array.isArray(e)){var t='<div class="color-picker-palette-row">';return t+=e.map(function(e){return'\n                <div class="color-picker-palette-value" data-palette-color="'+e+'" style="background-color: '+e+'"></div>\n              '}).join(""),t+="</div>"}return'\n              <div class="color-picker-palette-value" data-palette-color="'+e+'" style="background-color: '+e+'"></div>\n            '}).join("")+"\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=$(t.target).attr("data-palette-color");e.setValue({hex:a})}e.$el.on("click",".color-picker-module-palette .color-picker-palette-value",t),e.destroyPaletteEvents=function(){e.$el.off("click",".color-picker-module-hex input",t)}},destroy:function(e){e.destroyPaletteEvents&&e.destroyPaletteEvents(),delete e.destroyPaletteEvents}},moduleInitialCurrentColors={render:function(){return'\n      <div class="color-picker-module color-picker-module-initial-current-colors">\n        <div class="color-picker-initial-current-colors">\n          <div class="color-picker-initial-color"></div>\n          <div class="color-picker-current-color"></div>\n        </div>\n      </div>\n    '},init:function(e){function t(){if(e.initialValue){var t=e.initialValue,a=t.hex,r=t.alpha;e.setValue({hex:a,alpha:r})}}e.$el.on("click",".color-picker-initial-color",t),e.destroyInitialCurrentEvents=function(){e.$el.off("click",".color-picker-initial-color",t)}},update:function(e){e.$el.find(".color-picker-module-initial-current-colors .color-picker-initial-color").css("background-color",e.initialValue.hex),e.$el.find(".color-picker-module-initial-current-colors .color-picker-current-color").css("background-color",e.value.hex)},destroy:function(e){e.destroyInitialCurrentEvents&&e.destroyInitialCurrentEvents(),delete e.destroyInitialCurrentEvents}},moduleRgbBars={render:function(e){var t=e.params,a=t.barLabel,r=t.barValue,i=t.barValueEditable,n=t.redLabelText,s=t.greenLabelText,o=t.blueLabelText;return'\n      <div class="color-picker-module color-picker-module-rgb-bars">\n        <div class="color-picker-bar-wrap">\n          '+(a?'\n            <div class="color-picker-bar-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-bar color-picker-bar-red"></div>\n          '+(r?'\n            <div class="color-picker-bar-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-bar-red" data-color-index="0">\n              ':'\n                <span class="color-picker-value-bar-red"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-bar-wrap">\n          '+(a?'\n            <div class="color-picker-bar-label">'+s+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-bar color-picker-bar-green"></div>\n          '+(r?'\n            <div class="color-picker-bar-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-bar-green" data-color-index="1">\n              ':'\n                <span class="color-picker-value-bar-green"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-bar-wrap">\n          '+(a?'\n            <div class="color-picker-bar-label">'+o+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-bar color-picker-bar-blue"></div>\n          '+(r?'\n            <div class="color-picker-bar-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-bar-blue" data-color-index="2">\n              ':'\n                <span class="color-picker-value-bar-blue"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=[].concat(e.value.rgb),r=parseInt($(t.target).attr("data-color-index"),10),i=parseInt(t.target.value,10);Number.isNaN(i)?t.target.value=a[r]:(i=Math.max(0,Math.min(255,i)),a[r]=i,e.setValue({rgb:a}))}e.redBar=e.app.range.create({el:e.$el.find(".color-picker-bar-red"),min:0,max:255,step:1,value:0,vertical:!0,on:{change:function(t,a){e.setValue({rgb:[a,e.value.rgb[1],e.value.rgb[2]]})}}}),e.greenBar=e.app.range.create({el:e.$el.find(".color-picker-bar-green"),min:0,max:255,step:1,value:0,vertical:!0,on:{change:function(t,a){e.setValue({rgb:[e.value.rgb[0],a,e.value.rgb[2]]})}}}),e.blueBar=e.app.range.create({el:e.$el.find(".color-picker-bar-blue"),min:0,max:255,step:1,value:0,vertical:!0,on:{change:function(t,a){e.setValue({rgb:[e.value.rgb[0],e.value.rgb[1],a]})}}}),e.$el.on("change",".color-picker-module-rgb-bars input",t),e.destroyRgbBarsEvents=function(){e.$el.off("change",".color-picker-module-rgb-bars input",t)}},update:function(e){var t=e.value,a=e.redBar,r=e.greenBar,i=e.blueBar,n=e.params,s=n.barValue,o=n.barValueEditable,l=t.rgb;a.value=l[0],r.value=l[1],i.value=l[2],a.layout(),r.layout(),i.layout(),a.$el.find(".range-bar").css("background-image","linear-gradient(to top, rgb(0, "+l[1]+", "+l[2]+"), rgb(255, "+l[1]+", "+l[2]+"))"),r.$el.find(".range-bar").css("background-image","linear-gradient(to top, rgb("+l[0]+", 0, "+l[2]+"), rgb("+l[0]+", 255, "+l[2]+"))"),i.$el.find(".range-bar").css("background-image","linear-gradient(to top, rgb("+l[0]+", "+l[1]+", 0), rgb("+l[0]+", "+l[1]+", 255))"),s&&o?(e.$el.find("input.color-picker-value-bar-red").val(l[0]),e.$el.find("input.color-picker-value-bar-green").val(l[1]),e.$el.find("input.color-picker-value-bar-blue").val(l[2])):s&&(e.$el.find("span.color-picker-value-bar-red").text(l[0]),e.$el.find("span.color-picker-value-bar-green").text(l[1]),e.$el.find("span.color-picker-value-bar-blue").text(l[2]))},destroy:function(e){e.redBar&&e.redBar.destroy&&e.redBar.destroy(),e.greenBar&&e.greenBar.destroy&&e.greenBar.destroy(),e.blueBar&&e.blueBar.destroy&&e.blueBar.destroy(),delete e.redBar,delete e.greenBar,delete e.blueBar,e.destroyRgbBarsEvents&&e.destroyRgbBarsEvents(),delete e.destroyRgbBarsEvents}},moduleRgbSliders={render:function(e){var t=e.params,a=t.sliderLabel,r=t.sliderValue,i=t.sliderValueEditable,n=t.redLabelText,s=t.greenLabelText,o=t.blueLabelText;return'\n      <div class="color-picker-module color-picker-module-rgb-sliders">\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+n+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-red"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-red" data-color-index="0">\n              ':'\n                <span class="color-picker-value-red"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+s+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-green"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-green" data-color-index="1">\n              ':'\n                <span class="color-picker-value-green"></span>\n              ')+"\n            </div>\n          ":"")+'\n        </div>\n        <div class="color-picker-slider-wrap">\n          '+(a?'\n            <div class="color-picker-slider-label">'+o+"</div>\n          ":"")+'\n          <div class="range-slider color-picker-slider color-picker-slider-blue"></div>\n          '+(r?'\n            <div class="color-picker-slider-value">\n              '+(i?'\n                <input type="number" step="1" min="0" max="255" class="color-picker-value-blue" data-color-index="2">\n              ':'\n                <span class="color-picker-value-blue"></span>\n              ')+"\n            </div>\n          ":"")+"\n        </div>\n      </div>\n    "},init:function(e){function t(t){var a=[].concat(e.value.rgb),r=parseInt($(t.target).attr("data-color-index"),10),i=parseInt(t.target.value,10);Number.isNaN(i)?t.target.value=a[r]:(i=Math.max(0,Math.min(255,i)),a[r]=i,e.setValue({rgb:a}))}e.redRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-red"),min:0,max:255,step:1,value:0,on:{change:function(t,a){e.setValue({rgb:[a,e.value.rgb[1],e.value.rgb[2]]})}}}),e.greenRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-green"),min:0,max:255,step:1,value:0,on:{change:function(t,a){e.setValue({rgb:[e.value.rgb[0],a,e.value.rgb[2]]})}}}),e.blueRangeSlider=e.app.range.create({el:e.$el.find(".color-picker-slider-blue"),min:0,max:255,step:1,value:0,on:{change:function(t,a){e.setValue({rgb:[e.value.rgb[0],e.value.rgb[1],a]})}}}),e.$el.on("change",".color-picker-module-rgb-sliders input",t),e.destroyRgbSlidersEvents=function(){e.$el.off("change",".color-picker-module-rgb-sliders input",t)}},update:function(e){var t=e.app,a=e.value,r=e.redRangeSlider,i=e.greenRangeSlider,n=e.blueRangeSlider,s=e.params,o=s.sliderValue,l=s.sliderValueEditable,p=a.rgb;r.value=p[0],i.value=p[1],n.value=p[2],r.layout(),i.layout(),n.layout(),r.$el[0].style.setProperty("--f7-range-knob-color","rgb("+p[0]+", "+p[1]+", "+p[2]+")"),i.$el[0].style.setProperty("--f7-range-knob-color","rgb("+p[0]+", "+p[1]+", "+p[2]+")"),n.$el[0].style.setProperty("--f7-range-knob-color","rgb("+p[0]+", "+p[1]+", "+p[2]+")");var c=t.rtl?"to left":"to right";r.$el.find(".range-bar").css("background-image","linear-gradient("+c+", rgb(0, "+p[1]+", "+p[2]+"), rgb(255, "+p[1]+", "+p[2]+"))"),i.$el.find(".range-bar").css("background-image","linear-gradient("+c+", rgb("+p[0]+", 0, "+p[2]+"), rgb("+p[0]+", 255, "+p[2]+"))"),n.$el.find(".range-bar").css("background-image","linear-gradient("+c+", rgb("+p[0]+", "+p[1]+", 0), rgb("+p[0]+", "+p[1]+", 255))"),o&&l?(e.$el.find("input.color-picker-value-red").val(p[0]),e.$el.find("input.color-picker-value-green").val(p[1]),e.$el.find("input.color-picker-value-blue").val(p[2])):o&&(e.$el.find("span.color-picker-value-red").text(p[0]),e.$el.find("span.color-picker-value-green").text(p[1]),e.$el.find("span.color-picker-value-blue").text(p[2]))},destroy:function(e){e.redRangeSlider&&e.redRangeSlider.destroy&&e.redRangeSlider.destroy(),e.greenRangeSlider&&e.greenRangeSlider.destroy&&e.greenRangeSlider.destroy(),e.blueRangeSlider&&e.blueRangeSlider.destroy&&e.blueRangeSlider.destroy(),delete e.redRangeSlider,delete e.greenRangeSlider,delete e.blueRangeSlider,e.destroyRgbSlidersEvents&&e.destroyRgbSlidersEvents(),delete e.destroyRgbSlidersEvents}},moduleSbSpectrum={render:function(){return'\n      <div class="color-picker-module color-picker-module-sb-spectrum">\n        <div class="color-picker-sb-spectrum" style="background-color: hsl(0, 100%, 50%)">\n          <div class="color-picker-sb-spectrum-handle"></div>\n        </div>\n      </div>\n    '},init:function(e){var t,a,r,i,n,s,o,l,p,c=e.app,d=e.$el;function u(t,a){var r=(t-o.left)/o.width,i=(a-o.top)/o.height;r=Math.max(0,Math.min(1,r)),i=1-Math.max(0,Math.min(1,i)),e.setValue({hsb:[e.value.hue,r,i]})}function h(e){if(!a&&!t){r="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,n=r,i="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,s=i;var c=$(e.target);(p=c.closest(".color-picker-sb-spectrum-handle").length>0)||(l=c.closest(".color-picker-sb-spectrum").length>0),l&&(o=d.find(".color-picker-sb-spectrum")[0].getBoundingClientRect(),u(r,i)),(p||l)&&d.find(".color-picker-sb-spectrum-handle").addClass("color-picker-sb-spectrum-handle-pressed")}}function f(e){(l||p)&&(n="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,s="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,e.preventDefault(),a||(a=!0,p&&(o=d.find(".color-picker-sb-spectrum")[0].getBoundingClientRect())),(l||p)&&u(n,s))}function v(){a=!1,(l||p)&&d.find(".color-picker-sb-spectrum-handle").removeClass("color-picker-sb-spectrum-handle-pressed"),l=!1,p=!1}function m(){e.modules["sb-spectrum"].update(e)}var g=!("touchstart"!==c.touchEvents.start||!c.support.passiveListener)&&{passive:!0,capture:!1};e.$el.on(c.touchEvents.start,h,g),c.on("touchmove:active",f),c.on("touchend:passive",v),c.on("resize",m),e.destroySpectrumEvents=function(){e.$el.off(c.touchEvents.start,h,g),c.off("touchmove:active",f),c.off("touchend:passive",v),c.off("resize",m)}},update:function(e){var t=e.value,a=t.hsl,r=t.hsb,i=e.$el.find(".color-picker-sb-spectrum")[0].offsetWidth,n=e.$el.find(".color-picker-sb-spectrum")[0].offsetHeight;e.$el.find(".color-picker-sb-spectrum").css("background-color","hsl("+a[0]+", 100%, 50%)"),e.$el.find(".color-picker-sb-spectrum-handle").css("background-color","hsl("+a[0]+", "+100*a[1]+"%, "+100*a[2]+"%)").transform("translate("+i*r[1]+"px, "+n*(1-r[2])+"px)")},destroy:function(e){e.destroySpectrumEvents&&e.destroySpectrumEvents(),delete e.destroySpectrumEvents}},moduleHsSpectrum={render:function(){return'\n      <div class="color-picker-module color-picker-module-hs-spectrum">\n        <div class="color-picker-hs-spectrum">\n          <div class="color-picker-hs-spectrum-handle"></div>\n        </div>\n      </div>\n    '},init:function(e){var t,a,r,i,n,s,o,l,p,c=e.app,d=e.$el;function u(t,a){var r=(t-o.left)/o.width*360,i=(a-o.top)/o.height;r=Math.max(0,Math.min(360,r)),i=1-Math.max(0,Math.min(1,i)),e.setValue({hsb:[r,i,e.value.hsb[2]]})}function h(e){if(!a&&!t){r="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,n=r,i="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,s=i;var c=$(e.target);(p=c.closest(".color-picker-hs-spectrum-handle").length>0)||(l=c.closest(".color-picker-hs-spectrum").length>0),l&&(o=d.find(".color-picker-hs-spectrum")[0].getBoundingClientRect(),u(r,i)),(p||l)&&d.find(".color-picker-hs-spectrum-handle").addClass("color-picker-hs-spectrum-handle-pressed")}}function f(e){(l||p)&&(n="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,s="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,e.preventDefault(),a||(a=!0,p&&(o=d.find(".color-picker-hs-spectrum")[0].getBoundingClientRect())),(l||p)&&u(n,s))}function v(){a=!1,(l||p)&&d.find(".color-picker-hs-spectrum-handle").removeClass("color-picker-hs-spectrum-handle-pressed"),l=!1,p=!1}function m(){e.modules["hs-spectrum"].update(e)}var g=!("touchstart"!==c.touchEvents.start||!c.support.passiveListener)&&{passive:!0,capture:!1};e.$el.on(c.touchEvents.start,h,g),c.on("touchmove:active",f),c.on("touchend:passive",v),c.on("resize",m),e.destroySpectrumEvents=function(){e.$el.off(c.touchEvents.start,h,g),c.off("touchmove:active",f),c.off("touchend:passive",v),c.off("resize",m)}},update:function(e){var t=e.value.hsb,a=e.$el.find(".color-picker-hs-spectrum")[0].offsetWidth,r=e.$el.find(".color-picker-hs-spectrum")[0].offsetHeight,i=Utils.colorHsbToHsl(t[0],t[1],1);e.$el.find(".color-picker-hs-spectrum-handle").css("background-color","hsl("+i[0]+", "+100*i[1]+"%, "+100*i[2]+"%)").transform("translate("+a*(t[0]/360)+"px, "+r*(1-t[1])+"px)")},destroy:function(e){e.destroySpectrumEvents&&e.destroySpectrumEvents(),delete e.destroySpectrumEvents}};function svgWheelCircles(){for(var e="",t=256;t>0;t-=1){var a=t*Math.PI/128,r=1.40625*t;e+='<circle cx="'+(150-125*Math.sin(a))+'" cy="'+(150-125*Math.cos(a))+'" r="25" fill="hsl('+r+', 100%, 50%)"></circle>'}return e}var moduleWheel={render:function(){return'\n      <div class="color-picker-module color-picker-module-wheel">\n        <div class="color-picker-wheel">\n          <svg viewBox="0 0 300 300" width="300" height="300">'+svgWheelCircles()+'</svg>\n          <div class="color-picker-wheel-handle"></div>\n          <div class="color-picker-sb-spectrum" style="background-color: hsl(0, 100%, 50%)">\n            <div class="color-picker-sb-spectrum-handle"></div>\n          </div>\n        </div>\n      </div>\n    '},init:function(e){var t,a,r,i,n,s,o,l,p,c,d,u,h=e.app,f=e.$el;function v(t,a){var r=o.left+o.width/2,i=o.top+o.height/2,n=180*Math.atan2(a-i,t-r)/Math.PI+90;n<0&&(n+=360),n=360-n,e.setValue({hue:n})}function m(t,a){var r=(t-c.left)/c.width,i=(a-c.top)/c.height;r=Math.max(0,Math.min(1,r)),i=1-Math.max(0,Math.min(1,i)),e.setValue({hsb:[e.value.hue,r,i]})}function g(e){if(!a&&!t){r="touchstart"===e.type?e.targetTouches[0].pageX:e.pageX,n=r,i="touchstart"===e.type?e.targetTouches[0].pageY:e.pageY,s=i;var h=$(e.target);p=h.closest(".color-picker-wheel-handle").length>0,l=h.closest("circle").length>0,(u=h.closest(".color-picker-sb-spectrum-handle").length>0)||(d=h.closest(".color-picker-sb-spectrum").length>0),l&&(o=f.find(".color-picker-wheel")[0].getBoundingClientRect(),v(r,i)),d&&(c=f.find(".color-picker-sb-spectrum")[0].getBoundingClientRect(),m(r,i)),(u||d)&&f.find(".color-picker-sb-spectrum-handle").addClass("color-picker-sb-spectrum-handle-pressed")}}function b(e){(l||p||d||u)&&(n="touchmove"===e.type?e.targetTouches[0].pageX:e.pageX,s="touchmove"===e.type?e.targetTouches[0].pageY:e.pageY,e.preventDefault(),a||(a=!0,p&&(o=f.find(".color-picker-wheel")[0].getBoundingClientRect()),u&&(c=f.find(".color-picker-sb-spectrum")[0].getBoundingClientRect())),(l||p)&&v(n,s),(d||u)&&m(n,s))}function y(){a=!1,(d||u)&&f.find(".color-picker-sb-spectrum-handle").removeClass("color-picker-sb-spectrum-handle-pressed"),l=!1,p=!1,d=!1,u=!1}function w(){e.modules.wheel.update(e)}var C=!("touchstart"!==h.touchEvents.start||!h.support.passiveListener)&&{passive:!0,capture:!1};e.$el.on(h.touchEvents.start,g,C),h.on("touchmove:active",b),h.on("touchend:passive",y),h.on("resize",w),e.destroyWheelEvents=function(){e.$el.off(h.touchEvents.start,g,C),h.off("touchmove:active",b),h.off("touchend:passive",y),h.off("resize",w)}},update:function(e){var t=e.value,a=t.hsl,r=t.hsb,i=e.$el.find(".color-picker-sb-spectrum")[0].offsetWidth,n=e.$el.find(".color-picker-sb-spectrum")[0].offsetHeight,s=e.$el.find(".color-picker-wheel")[0].offsetWidth,o=s/2,l=t.hue*Math.PI/180,p=s/6/2,c=o-Math.sin(l)*(o-p)-p,d=o-Math.cos(l)*(o-p)-p;e.$el.find(".color-picker-wheel-handle").css("background-color","hsl("+a[0]+", 100%, 50%)").transform("translate("+c+"px, "+d+"px)"),e.$el.find(".color-picker-sb-spectrum").css("background-color","hsl("+a[0]+", 100%, 50%)"),e.$el.find(".color-picker-sb-spectrum-handle").css("background-color","hsl("+a[0]+", "+100*a[1]+"%, "+100*a[2]+"%)").transform("translate("+i*r[1]+"px, "+n*(1-r[2])+"px)")},destroy:function(e){e.destroyWheelEvents&&e.destroyWheelEvents(),delete e.destroyWheelEvents}},ColorPicker=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i,n,s,o=this;if(o.params=Utils.extend({},t.params.colorPicker,a),o.params.containerEl&&0===(r=$(o.params.containerEl)).length)return o;function l(){o.open()}function p(e){e.preventDefault()}function c(){o.open()}function d(e){if(!o.destroyed&&o.params&&"page"!==o.params.openIn){var t=$(e.target);o.opened&&!o.closing&&(t.closest('[class*="backdrop"]').length||t.closest(".color-picker-popup, .color-picker-popover").length||(i&&i.length>0?t[0]!==i[0]&&0===t.closest(".sheet-modal").length&&o.close():0===$(e.target).closest(".sheet-modal").length&&o.close()))}}return o.params.inputEl&&(i=$(o.params.inputEl)),o.params.targetEl&&(n=$(o.params.targetEl)),i&&(s=i.parents(".view").length&&i.parents(".view")[0].f7View),!s&&n&&(s=n.parents(".view").length&&n.parents(".view")[0].f7View),s||(s=t.views.main),Utils.extend(o,{app:t,$containerEl:r,containerEl:r&&r[0],inline:r&&r.length>0,$inputEl:i,inputEl:i&&i[0],$targetEl:n,targetEl:n&&n[0],initialized:!1,opened:!1,url:o.params.url,view:s,modules:{"alpha-slider":moduleAlphaSlider,"current-color":moduleCurrentColor,hex:moduleHex,"hsb-sliders":moduleHsbSliders,"hue-slider":moduleHueSlider,"brightness-slider":moduleBrightnessSlider,palette:modulePalette,"initial-current-colors":moduleInitialCurrentColors,"rgb-bars":moduleRgbBars,"rgb-sliders":moduleRgbSliders,"sb-spectrum":moduleSbSpectrum,"hs-spectrum":moduleHsSpectrum,wheel:moduleWheel}}),Utils.extend(o,{attachInputEvents:function(){o.$inputEl.on("click",l),o.params.inputReadOnly&&o.$inputEl.on("focus mousedown",p)},detachInputEvents:function(){o.$inputEl.off("click",l),o.params.inputReadOnly&&o.$inputEl.off("focus mousedown",p)},attachTargetEvents:function(){o.$targetEl.on("click",c)},detachTargetEvents:function(){o.$targetEl.off("click",c)},attachHtmlEvents:function(){t.on("click",d)},detachHtmlEvents:function(){t.off("click",d)}}),o.init(),o}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.attachEvents=function(){this.centerModules=this.centerModules.bind(this),this.params.centerModules&&this.app.on("resize",this.centerModules)},t.prototype.detachEvents=function(){this.params.centerModules&&this.app.off("resize",this.centerModules)},t.prototype.centerModules=function(){if(this.opened&&this.$el&&!this.inline){var e=this.$el.find(".page-content");if(e.length){var t=e[0];t.scrollHeight<=t.offsetHeight?e.addClass("justify-content-center"):e.removeClass("justify-content-center")}}},t.prototype.initInput=function(){this.$inputEl&&this.params.inputReadOnly&&this.$inputEl.prop("readOnly",!0)},t.prototype.getModalType=function(){var e=this.app,t=this.modal,a=this.params,r=a.openIn,i=a.openInPhone;return t&&t.type?t.type:"auto"!==r?r:this.inline?null:e.device.ios?e.device.ipad?"popover":i:e.width>=768||e.device.desktop&&"aurora"===e.theme?"popover":i},t.prototype.formatValue=function(){var e=this.value;return this.params.formatValue?this.params.formatValue.call(this,e):e.hex},t.prototype.normalizeHsValues=function(e){return[Math.floor(10*e[0])/10,Math.floor(1e3*e[1])/1e3,Math.floor(1e3*e[2])/1e3]},t.prototype.setValue=function(e,t){void 0===e&&(e={}),void 0===t&&(t=!0);var a=this;if(void 0!==e){var r=a.value||{},i=r.hex,n=r.rgb,s=r.hsl,o=r.hsb,l=r.alpha;void 0===l&&(l=1);var p,c=r.hue,d=r.rgba,u=r.hsla,h=a.value||!a.value&&!a.params.value;if(Object.keys(e).forEach(function(t){if(a.value&&void 0!==a.value[t]){var r=e[t];Array.isArray(r)?r.forEach(function(e,r){e!==a.value[t][r]&&(p=!0)}):r!==a.value[t]&&(p=!0)}else p=!0}),p){if(e.rgb||e.rgba){var f=e.rgb||e.rgba,v=f[0],m=f[1],g=f[2],b=f[3];void 0===b&&(b=l),n=[v,m,g],i=Utils.colorRgbToHex.apply(Utils,n),s=Utils.colorRgbToHsl.apply(Utils,n),o=Utils.colorHslToHsb.apply(Utils,s),s=a.normalizeHsValues(s),c=(o=a.normalizeHsValues(o))[0],l=b,d=[n[0],n[1],n[2],b],u=[s[0],s[1],s[2],b]}if(e.hsl||e.hsla){var y=e.hsl||e.hsla,w=y[0],C=y[1],x=y[2],$=y[3];void 0===$&&($=l),s=[w,C,x],n=Utils.colorHslToRgb.apply(Utils,s),i=Utils.colorRgbToHex.apply(Utils,n),o=Utils.colorHslToHsb.apply(Utils,s),s=a.normalizeHsValues(s),c=(o=a.normalizeHsValues(o))[0],l=$,d=[n[0],n[1],n[2],$],u=[s[0],s[1],s[2],$]}if(e.hsb){var k=e.hsb,E=k[0],S=k[1],T=k[2],M=k[3];void 0===M&&(M=l),o=[E,S,T],s=Utils.colorHsbToHsl.apply(Utils,o),n=Utils.colorHslToRgb.apply(Utils,s),i=Utils.colorRgbToHex.apply(Utils,n),s=a.normalizeHsValues(s),c=(o=a.normalizeHsValues(o))[0],l=M,d=[n[0],n[1],n[2],M],u=[s[0],s[1],s[2],M]}if(e.hex&&(n=Utils.colorHexToRgb(e.hex),i=Utils.colorRgbToHex.apply(Utils,n),s=Utils.colorRgbToHsl.apply(Utils,n),o=Utils.colorHslToHsb.apply(Utils,s),s=a.normalizeHsValues(s),c=(o=a.normalizeHsValues(o))[0],d=[n[0],n[1],n[2],l],u=[s[0],s[1],s[2],l]),void 0!==e.alpha&&(l=e.alpha,void 0!==n&&(d=[n[0],n[1],n[2],l]),void 0!==s&&(u=[s[0],s[1],s[2],l])),void 0!==e.hue){s[0];var P=s[1],O=s[2];s=[e.hue,P,O],o=Utils.colorHslToHsb.apply(Utils,s),n=Utils.colorHslToRgb.apply(Utils,s),i=Utils.colorRgbToHex.apply(Utils,n),s=a.normalizeHsValues(s),c=(o=a.normalizeHsValues(o))[0],d=[n[0],n[1],n[2],l],u=[s[0],s[1],s[2],l]}a.value={hex:i,alpha:l,hue:c,rgb:n,hsl:s,hsb:o,rgba:d,hsla:u},a.initialValue||(a.initialValue=Utils.extend({},a.value)),a.updateValue(h),a.opened&&t&&a.updateModules()}}},t.prototype.getValue=function(){return this.value},t.prototype.updateValue=function(e){void 0===e&&(e=!0);var t=this.$inputEl,a=this.value,r=this.$targetEl;if(r&&this.params.targetElSetBackgroundColor){var i=a.rgba;r.css("background-color","rgba("+i.join(", ")+")")}if(e&&this.emit("local::change colorPickerChange",this,a),t&&t.length){var n=this.formatValue(a);t&&t.length&&(t.val(n),e&&t.trigger("change"))}},t.prototype.updateModules=function(){var e=this,t=e.modules;e.params.modules.forEach(function(a){"string"==typeof a&&t[a]&&t[a].update?t[a].update(e):a&&a.update&&a.update(e)})},t.prototype.update=function(){this.updateModules()},t.prototype.renderPicker=function(){var e=this,t=e.params,a=e.modules,r="";return t.modules.forEach(function(t){"string"==typeof t&&a[t]&&a[t].render?r+=a[t].render(e):t&&t.render&&(r+=t.render(e))}),r},t.prototype.renderNavbar=function(){if(this.params.renderNavbar)return this.params.renderNavbar.call(this,this);var e=this.params,t=e.openIn,a=e.navbarTitleText,r=e.navbarBackLinkText,i=e.navbarCloseText;return('\n    <div class="navbar">\n      <div class="navbar-inner sliding">\n        '+("page"===t?'\n        <div class="left">\n          <a class="link back">\n            <i class="icon icon-back"></i>\n            <span class="if-not-md">'+r+"</span>\n          </a>\n        </div>\n        ":"")+'\n        <div class="title">'+a+"</div>\n        "+("page"!==t?'\n        <div class="right">\n          <a class="link popup-close" data-popup=".color-picker-popup">'+i+"</a>\n        </div>\n        ":"")+"\n      </div>\n    </div>\n  ").trim()},t.prototype.renderToolbar=function(){return this.params.renderToolbar?this.params.renderToolbar.call(this,this):('\n    <div class="toolbar toolbar-top no-shadow">\n      <div class="toolbar-inner">\n        <div class="left"></div>\n        <div class="right">\n          <a class="link sheet-close popover-close" data-sheet=".color-picker-sheet-modal" data-popover=".color-picker-popover">'+this.params.toolbarCloseText+"</a>\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.renderInline=function(){var e=this.params,t=e.cssClass;return('\n    <div class="color-picker color-picker-inline '+(e.groupedModules?"color-picker-grouped-modules":"")+" "+(t||"")+'">\n      '+this.renderPicker()+"\n    </div>\n  ").trim()},t.prototype.renderSheet=function(){var e=this.params,t=e.cssClass,a=e.toolbarSheet;return('\n    <div class="sheet-modal color-picker color-picker-sheet-modal '+(e.groupedModules?"color-picker-grouped-modules":"")+" "+(t||"")+'">\n      '+(a?this.renderToolbar():"")+'\n      <div class="sheet-modal-inner">\n        <div class="page-content">\n          '+this.renderPicker()+"\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.renderPopover=function(){var e=this.params,t=e.cssClass,a=e.toolbarPopover;return('\n    <div class="popover color-picker-popover '+(t||"")+'">\n      <div class="popover-inner">\n        <div class="color-picker '+(e.groupedModules?"color-picker-grouped-modules":"")+'">\n          '+(a?this.renderToolbar():"")+'\n          <div class="page-content">\n            '+this.renderPicker()+"\n          </div>\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.renderPopup=function(){var e=this.params,t=e.cssClass,a=e.navbarPopup,r=e.groupedModules;return('\n    <div class="popup color-picker-popup '+(t||"")+'">\n      <div class="page">\n        '+(a?this.renderNavbar():"")+'\n        <div class="color-picker '+(r?"color-picker-grouped-modules":"")+'">\n          <div class="page-content">\n            '+this.renderPicker()+"\n          </div>\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.renderPage=function(){var e=this.params,t=e.cssClass,a=e.groupedModules;return('\n    <div class="page color-picker-page '+(t||"")+'" data-name="color-picker-page">\n      '+this.renderNavbar()+'\n      <div class="color-picker '+(a?"color-picker-grouped-modules":"")+'">\n        <div class="page-content">\n          '+this.renderPicker()+"\n        </div>\n      </div>\n    </div>\n  ").trim()},t.prototype.render=function(){var e=this.params;if(e.render)return e.render.call(this);if(this.inline)return this.renderInline();if("page"===e.openIn)return this.renderPage();var t=this.getModalType();return"popover"===t?this.renderPopover():"sheet"===t?this.renderSheet():"popup"===t?this.renderPopup():void 0},t.prototype.onOpen=function(){var e=this,t=e.initialized,a=e.$el,r=e.app,i=e.$inputEl,n=e.inline,s=e.value,o=e.params,l=e.modules;e.closing=!1,e.opened=!0,e.opening=!0,e.attachEvents(),o.modules.forEach(function(t){"string"==typeof t&&l[t]&&l[t].init?l[t].init(e):t&&t.init&&t.init(e)});var p=!s&&o.value;t?s&&(e.initialValue=Utils.extend({},s),e.setValue(s,!1)):s?e.setValue(s):o.value?e.setValue(o.value,!1):o.value||e.setValue({hex:"#ff0000"},!1),p&&e.updateValue(),e.updateModules(),o.centerModules&&e.centerModules(),!n&&i&&i.length&&"md"===r.theme&&i.trigger("focus"),e.initialized=!0,a&&a.trigger("colorpicker:open",e),i&&i.trigger("colorpicker:open",e),e.emit("local::open colorPickerOpen",e)},t.prototype.onOpened=function(){this.opening=!1,this.$el&&this.$el.trigger("colorpicker:opened",this),this.$inputEl&&this.$inputEl.trigger("colorpicker:opened",this),this.emit("local::opened colorPickerOpened",this)},t.prototype.onClose=function(){var e=this,t=e.app,a=e.params,r=e.modules;e.opening=!1,e.closing=!0,e.detachEvents(),e.$inputEl&&"md"===t.theme&&e.$inputEl.trigger("blur"),a.modules.forEach(function(t){"string"==typeof t&&r[t]&&r[t].destroy?r[t].destroy(e):t&&t.destroy&&t.destroy(e)}),e.$el&&e.$el.trigger("colorpicker:close",e),e.$inputEl&&e.$inputEl.trigger("colorpicker:close",e),e.emit("local::close colorPickerClose",e)},t.prototype.onClosed=function(){var e=this;e.opened=!1,e.closing=!1,e.inline||Utils.nextTick(function(){e.modal&&e.modal.el&&e.modal.destroy&&(e.params.routableModals||e.modal.destroy()),delete e.modal}),e.$el&&e.$el.trigger("colorpicker:closed",e),e.$inputEl&&e.$inputEl.trigger("colorpicker:closed",e),e.emit("local::closed colorPickerClosed",e)},t.prototype.open=function(){var e,t=this,a=t.app,r=t.opened,i=t.inline,n=t.$inputEl,s=t.$targetEl,o=t.params;if(!r){if(i)return t.$el=$(t.render()),t.$el[0].f7ColorPicker=t,t.$containerEl.append(t.$el),t.onOpen(),void t.onOpened();var l=t.render();if("page"===o.openIn)t.view.router.navigate({url:t.url,route:{content:l,path:t.url,on:{pageBeforeIn:function(e,a){t.$el=a.$el.find(".color-picker"),t.$el[0].f7ColorPicker=t,t.onOpen()},pageAfterIn:function(){t.onOpened()},pageBeforeOut:function(){t.onClose()},pageAfterOut:function(){t.onClosed(),t.$el&&t.$el[0]&&(t.$el[0].f7ColorPicker=null,delete t.$el[0].f7ColorPicker)}}}});else{var p=t.getModalType(),c=o.backdrop;null==c&&("popover"===p&&!1!==a.params.popover.backdrop&&(c=!0),"popup"===p&&(c=!0));var d={targetEl:s||n,scrollToEl:o.scrollToInput?s||n:void 0,content:l,backdrop:c,closeByBackdropClick:o.closeByBackdropClick,on:{open:function(){t.modal=this,t.$el="popover"===p||"popup"===p?this.$el.find(".color-picker"):this.$el,t.$el[0].f7ColorPicker=t,t.onOpen()},opened:function(){t.onOpened()},close:function(){t.onClose()},closed:function(){t.onClosed(),t.$el&&t.$el[0]&&(t.$el[0].f7ColorPicker=null,delete t.$el[0].f7ColorPicker)}}};o.routableModals?t.view.router.navigate({url:t.url,route:(e={path:t.url},e[p]=d,e)}):(t.modal=a[p].create(d),t.modal.open())}}},t.prototype.close=function(){var e=this.opened,t=this.inline;if(e)return t?(this.onClose(),void this.onClosed()):void(this.params.routableModals?this.view.router.back():this.modal.close())},t.prototype.init=function(){if(this.initInput(),this.inline)return this.open(),void this.emit("local::init colorPickerInit",this);!this.initialized&&this.params.value&&this.setValue(this.params.value),this.$inputEl&&this.attachInputEvents(),this.$targetEl&&this.attachTargetEvents(),this.params.closeByOutsideClick&&this.attachHtmlEvents(),this.emit("local::init colorPickerInit",this)},t.prototype.destroy=function(){if(!this.destroyed){var e=this.$el;this.emit("local::beforeDestroy colorPickerBeforeDestroy",this),e&&e.trigger("colorpicker:beforedestroy",this),this.close(),this.detachEvents(),this.$inputEl&&this.detachInputEvents(),this.$targetEl&&this.detachTargetEvents(),this.params.closeByOutsideClick&&this.detachHtmlEvents(),e&&e.length&&delete this.$el[0].f7ColorPicker,Utils.deleteProps(this),this.destroyed=!0}},t}(Framework7Class),ColorPicker$1={name:"colorPicker",static:{ColorPicker:ColorPicker},create:function(){this.colorPicker=ConstructorMethods({defaultSelector:".color-picker",constructor:ColorPicker,app:this,domProp:"f7ColorPicker"}),this.colorPicker.close=function(e){void 0===e&&(e=".color-picker");var t=$(e);if(0!==t.length){var a=t[0].f7ColorPicker;!a||a&&!a.opened||a.close()}}},params:{colorPicker:{value:null,modules:["wheel"],palette:[["#FFEBEE","#FFCDD2","#EF9A9A","#E57373","#EF5350","#F44336","#E53935","#D32F2F","#C62828","#B71C1C"],["#F3E5F5","#E1BEE7","#CE93D8","#BA68C8","#AB47BC","#9C27B0","#8E24AA","#7B1FA2","#6A1B9A","#4A148C"],["#E8EAF6","#C5CAE9","#9FA8DA","#7986CB","#5C6BC0","#3F51B5","#3949AB","#303F9F","#283593","#1A237E"],["#E1F5FE","#B3E5FC","#81D4FA","#4FC3F7","#29B6F6","#03A9F4","#039BE5","#0288D1","#0277BD","#01579B"],["#E0F2F1","#B2DFDB","#80CBC4","#4DB6AC","#26A69A","#009688","#00897B","#00796B","#00695C","#004D40"],["#F1F8E9","#DCEDC8","#C5E1A5","#AED581","#9CCC65","#8BC34A","#7CB342","#689F38","#558B2F","#33691E"],["#FFFDE7","#FFF9C4","#FFF59D","#FFF176","#FFEE58","#FFEB3B","#FDD835","#FBC02D","#F9A825","#F57F17"],["#FFF3E0","#FFE0B2","#FFCC80","#FFB74D","#FFA726","#FF9800","#FB8C00","#F57C00","#EF6C00","#E65100"]],groupedModules:!1,centerModules:!0,sliderLabel:!1,sliderValue:!1,sliderValueEdiable:!1,barLabel:!1,barValue:!1,barValueEdiable:!1,hexLabel:!1,hexValueEditable:!1,redLabelText:"R",greenLabelText:"G",blueLabelText:"B",hueLabelText:"H",saturationLabelText:"S",brightnessLabelText:"B",hexLabelText:"HEX",alphaLabelText:"A",containerEl:null,openIn:"popover",openInPhone:"popup",formatValue:null,targetEl:null,targetElSetBackgroundColor:!1,inputEl:null,inputReadOnly:!0,closeByOutsideClick:!0,scrollToInput:!0,toolbarSheet:!0,toolbarPopover:!1,toolbarCloseText:"Done",navbarPopup:!0,navbarCloseText:"Done",navbarTitleText:"Color",navbarBackLinkText:"Back",cssClass:null,routableModals:!0,view:null,url:"color/",backdrop:null,closeByBackdropClick:!0,renderToolbar:null,renderNavbar:null,renderInline:null,renderPopover:null,renderSheet:null,renderPopup:null,render:null}}},Treeview={open:function(e){var t=$(e).eq(0);function a(){t[0].f7TreeviewChildrenLoaded=!0,t.find(".treeview-toggle").removeClass("treeview-toggle-hidden"),t.find(".treeview-preloader").remove()}t.length&&(t.addClass("treeview-item-opened"),t.trigger("treeview:open"),this.emit("treeviewOpen",t[0]),t.hasClass("treeview-load-children")&&!t[0].f7TreeviewChildrenLoaded&&(t.trigger("treeview:loadchildren",a),this.emit("treeviewLoadChildren",t[0],a),t.find(".treeview-toggle").addClass("treeview-toggle-hidden"),t.find(".treeview-item-root").prepend('<div class="preloader treeview-preloader">'+Utils[this.theme+"PreloaderContent"]+"</div>")))},close:function(e){var t=$(e).eq(0);t.length&&(t.removeClass("treeview-item-opened"),t.trigger("treeview:close"),this.emit("treeviewClose",t[0]))},toggle:function(e){var t=$(e).eq(0);if(t.length){var a=t.hasClass("treeview-item-opened");this.treeview[a?"close":"open"](t)}}},Treeview$1={name:"treeview",create:function(){Utils.extend(this,{treeview:{open:Treeview.open.bind(this),close:Treeview.close.bind(this),toggle:Treeview.toggle.bind(this)}})},clicks:{".treeview-toggle":function(e,t,a){if(!e.parents(".treeview-item-toggle").length){var r=e.parents(".treeview-item").eq(0);r.length&&(a.preventF7Router=!0,this.treeview.toggle(r[0]))}},".treeview-item-toggle":function(e,t,a){var r=e.closest(".treeview-item").eq(0);r.length&&(a.preventF7Router=!0,this.treeview.toggle(r[0]))}}},ViAd=function(e){function t(t,a){void 0===a&&(a={}),e.call(this,a,[t]);var r,i=this;if(!win.vi)throw new Error("Framework7: vi SDK not found.");void 0!==win.orientation&&(r=-90===win.orientation||90===win.orientation?"horizontal":"vertical");var n=Utils.extend({},t.params.vi,{appId:t.id,appVer:t.version,language:t.language,width:t.width,height:t.height,os:Device.os,osVersion:Device.osVersion,orientation:r});i.useModulesParams(n),i.params=Utils.extend(n,a);var s={},o="on autoplay fallbackOverlay fallbackOverlayText enabled".split(" ");if(Object.keys(i.params).forEach(function(e){if(!(o.indexOf(e)>=0)){var t=i.params[e];[null,void 0].indexOf(t)>=0||(s[e]=t)}}),!i.params.appId)throw new Error('Framework7: "app.id" is required to display an ad. Make sure you have specified it on app initialization.');if(!i.params.placementId)throw new Error('Framework7: "placementId" is required to display an ad.');function l(){var e=$("iframe#viAd");0!==e.length&&e.css({width:t.width+"px",height:t.height+"px"})}function p(){i.$overlayEl&&(i.$overlayEl.off("click touchstart"),i.$overlayEl.remove())}i.ad=new win.vi.Ad(s),Utils.extend(i.ad,{onAdReady:function(){t.on("resize",l),i.emit("local::ready"),i.params.autoplay&&i.start()},onAdStarted:function(){i.emit("local::started")},onAdClick:function(e){i.emit("local::click",e)},onAdImpression:function(){i.emit("local::impression")},onAdStopped:function(e){t.off("resize",l),p(),i.emit("local::stopped",e),"complete"===e&&(i.emit("local::complete"),i.emit("local::completed")),"userexit"===e&&i.emit("local::userexit"),i.destroyed=!0},onAutoPlayFailed:function(e,a){i.emit("local::autoplayFailed",e,a),e&&e.name&&-1!==e.name.indexOf("NotAllowedError")&&i.params.fallbackOverlay&&function(e){var a;e&&(i.$overlayEl=$(('\n        <div class="vi-overlay no-fastclick">\n          '+(i.params.fallbackOverlayText?'<div class="vi-overlay-text">'+i.params.fallbackOverlayText+"</div>":"")+'\n          <div class="vi-overlay-play-button"></div>\n        </div>\n      ').trim()),i.$overlayEl.on("touchstart",function(){a=Utils.now()}),i.$overlayEl.on("click",function(){if(!(Utils.now()-a>300)){if(e)return e.play(),void p();i.start(),p()}}),t.root.append(i.$overlayEl))}(a)},onAdError:function(e){p(),t.off("resize",l),i.emit("local::error",e),i.destroyed=!0}}),i.init(),Utils.extend(i,{app:t})}return e&&(t.__proto__=e),t.prototype=Object.create(e&&e.prototype),t.prototype.constructor=t,t.prototype.start=function(){this.destroyed||this.ad&&this.ad.startAd()},t.prototype.pause=function(){this.destroyed||this.ad&&this.ad.pauseAd()},t.prototype.resume=function(){this.destroyed||this.ad&&this.ad.resumeAd()},t.prototype.stop=function(){this.destroyed||this.ad&&this.ad.stopAd()},t.prototype.init=function(){this.destroyed||this.ad&&this.ad.initAd()},t.prototype.destroy=function(){this.destroyed=!0,this.emit("local::beforeDestroy"),Utils.deleteProps(this)},t}(Framework7Class),Vi={name:"vi",params:{vi:{enabled:!1,autoplay:!0,fallbackOverlay:!0,fallbackOverlayText:"Please watch this ad",showMute:!0,startMuted:(Device.ios||Device.android)&&!Device.cordova,appId:null,appVer:null,language:null,width:null,height:null,placementId:"pltd4o7ibb9rc653x14",placementType:"interstitial",videoSlot:null,showProgress:!0,showBranding:!0,os:null,osVersion:null,orientation:null,age:null,gender:null,advertiserId:null,latitude:null,longitude:null,accuracy:null,storeId:null,ip:null,manufacturer:null,model:null,connectionType:null,connectionProvider:null}},create:function(){var e=this;e.vi={sdkReady:!1,createAd:function(t){return new ViAd(e,t)},loadSdk:function(){if(!e.vi.sdkReady){var t=doc.createElement("script");t.onload=function(){e.emit("viSdkReady"),e.vi.sdkReady=!0},t.src="https://c.vi-serve.com/viadshtml/vi.min.js",$("head").append(t)}}}},on:{init:function(){(this.params.vi.enabled||this.passedParams.vi&&!1!==this.passedParams.vi.enabled)&&this.vi.loadSdk()}}},Elevation={name:"elevation"},Typography={name:"typography"};return"undefined"!=typeof window&&(window.Template7||(window.Template7=Template7),window.Dom7||(window.Dom7=$)),Router.use([RouterTemplateLoaderModule,RouterComponentLoaderModule]),Framework7.use([DeviceModule,SupportModule,UtilsModule,ResizeModule,RequestModule,TouchModule,ClicksModule,RouterModule,HistoryModule,StorageModule,ComponentModule,ServiceWorkerModule,Statusbar$1,View$1,Navbar$1,Toolbar$1,Subnavbar,TouchRipple$1,Modal$1,Appbar,Dialog$1,Popup$1,LoginScreen$1,Popover$1,Actions$1,Sheet$1,Toast$1,Preloader$1,Progressbar$1,Sortable$1,Swipeout$1,Accordion$1,ContactsList,VirtualList$1,ListIndex$1,Timeline,Tabs,Panel$1,Card,Chip,Form,Input$1,Checkbox,Radio,Toggle$1,Range$1,Stepper$1,SmartSelect$1,Grid,Calendar$1,Picker$1,InfiniteScroll$1,PullToRefresh$1,Lazy$1,DataTable$1,Fab$1,Searchbar$1,Messages$1,Messagebar$1,Swiper$1,PhotoBrowser$1,Notification$1,Autocomplete$1,Tooltip$1,Gauge$1,Skeleton,Menu$1,ColorPicker$1,Treeview$1,Vi,Elevation,Typography]),Framework7});
//# sourceMappingURL=framework7.bundle.min.js.map
$_mod.def("/app$1.0.0/src/routes/mobile/index.marko.init", function(require, exports, module, __filename, __dirname) { window.$initComponents && window.$initComponents();
});
$_mod.run("/app$1.0.0/src/routes/mobile/index.marko.init");