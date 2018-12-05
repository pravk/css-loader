/*
  MIT License http://www.opensource.org/licenses/mit-license.php
  Author Tobias Koppers @sokra
*/
import validateOptions from 'schema-utils';
import postcss from 'postcss';
import postcssPkg from 'postcss/package.json';
import localByDefault from 'postcss-modules-local-by-default';
import extractImports from 'postcss-modules-extract-imports';
import modulesScope from 'postcss-modules-scope';
import modulesValues from 'postcss-modules-values';
import {
  getOptions,
  isUrlRequest,
  urlToRequest,
  getRemainingRequest,
  getCurrentRequest,
  stringifyRequest,
} from 'loader-utils';

import schema from './options.json';
import { importParser, icssParser, urlParser } from './plugins';
import {
  getLocalIdent,
  getImportPrefix,
  compileExports,
  placholderRegExps,
} from './utils';
import Warning from './Warning';
import CssSyntaxError from './CssSyntaxError';

export default function loader(content, map, meta) {
  const options = getOptions(this) || {};

  validateOptions(schema, options, 'CSS Loader');

  const callback = this.async();
  const sourceMap = options.sourceMap || false;

  /* eslint-disable no-param-reassign */
  if (sourceMap) {
    if (map) {
      if (typeof map === 'string') {
        map = JSON.stringify(map);
      }

      if (map.sources) {
        map.sources = map.sources.map((source) => source.replace(/\\/g, '/'));
        map.sourceRoot = '';
      }
    }
  } else {
    // Some loaders (example `"postcss-loader": "1.x.x"`) always generates source map, we should remove it
    map = null;
  }
  /* eslint-enable no-param-reassign */

  // Reuse CSS AST (PostCSS AST e.g 'postcss-loader') to avoid reparsing
  if (meta) {
    const { ast } = meta;

    if (ast && ast.type === 'postcss' && ast.version === postcssPkg.version) {
      // eslint-disable-next-line no-param-reassign
      content = ast.root;
    }
  }

  const resolveImport = options.import !== false;
  const resolveUrl = options.url !== false;

  const plugins = [];

  if (options.modules) {
    const loaderContext = this;
    const mode =
      typeof options.modules === 'boolean' ? 'local' : options.modules;

    plugins.push(
      modulesValues,
      localByDefault({ mode }),
      extractImports(),
      modulesScope({
        generateScopedName: function generateScopedName(exportName) {
          const localIdentName = options.localIdentName || '[hash:base64]';
          const customGetLocalIdent = options.getLocalIdent || getLocalIdent;

          return customGetLocalIdent(
            loaderContext,
            localIdentName,
            exportName,
            {
              regExp: options.localIdentRegExp,
              hashPrefix: options.hashPrefix || '',
              context: options.context,
            }
          );
        },
      })
    );
  }

  if (resolveImport) {
    plugins.push(importParser());
  }

  if (resolveUrl) {
    plugins.push(
      urlParser({
        filter: (value) => isUrlRequest(value),
      })
    );
  }

  plugins.push(icssParser());

  postcss(plugins)
    .process(content, {
      // we need a prefix to avoid path rewriting of PostCSS
      from: `/css-loader!${getRemainingRequest(this)
        .split('!')
        .pop()}`,
      to: getCurrentRequest(this)
        .split('!')
        .pop(),
      map: options.sourceMap
        ? {
            prev: map,
            sourcesContent: true,
            inline: false,
            annotation: false,
          }
        : null,
    })
    .then((result) => {
      result
        .warnings()
        .forEach((warning) => this.emitWarning(new Warning(warning)));

      const messages = result.messages || [];
      const { camelCase, exportOnlyLocals, importLoaders } = options;

      // Run other loader (`postcss-loader`, `sass-loader` and etc) for importing CSS
      const importUrlPrefix = getImportPrefix(this, importLoaders);

      // Prepare replacer to change from `___CSS_LOADER_IMPORT___INDEX___` to `require('./file.css').locals`
      const importItemReplacer = (placeholder) => {
        const match = placholderRegExps.importItem.exec(placeholder);
        const idx = Number(match[1]);

        const message = messages.find(
          // eslint-disable-next-line no-shadow
          (message) =>
            message.type === 'icss-import' &&
            message.item &&
            message.item.index === idx
        );

        if (!message) {
          return placeholder;
        }

        const { item } = message;
        const importUrl = importUrlPrefix + urlToRequest(item.url);

        if (exportOnlyLocals) {
          return `" + require(${stringifyRequest(
            this,
            importUrl
          )})[${JSON.stringify(item.export)}] + "`;
        }

        return `" + require(${stringifyRequest(
          this,
          importUrl
        )}).locals[${JSON.stringify(item.export)}] + "`;
      };

      let exportCode = compileExports(messages, camelCase, (valueAsString) =>
        valueAsString.replace(placholderRegExps.importItemG, importItemReplacer)
      );

      if (exportOnlyLocals) {
        return callback(
          null,
          exportCode ? `module.exports = ${exportCode};` : exportCode
        );
      }

      const importCode = messages
        .filter((message) => message.type === 'import')
        .map((message) => {
          const { url } = message.item;
          const media = message.item.media || '';

          if (!isUrlRequest(url)) {
            return `exports.push([module.id, ${JSON.stringify(
              `@import url(${url});`
            )}, ${JSON.stringify(media)}]);`;
          }

          const importUrl = importUrlPrefix + urlToRequest(url);

          return `exports.i(require(${stringifyRequest(
            this,
            importUrl
          )}), ${JSON.stringify(media)});`;
        }, this)
        .join('\n');

      let cssAsString = JSON.stringify(result.css).replace(
        placholderRegExps.importItemG,
        importItemReplacer
      );

      // helper for ensuring valid CSS strings from requires
      let urlEscapeHelperCode = '';

      messages
        .filter((message) => message.type === 'url')
        .forEach((message) => {
          if (!urlEscapeHelperCode) {
            urlEscapeHelperCode = `var escape = require(${stringifyRequest(
              this,
              require.resolve('./runtime/escape.js')
            )});\n`;
          }

          const { item } = message;
          const { url, placeholder } = item;

          cssAsString = cssAsString.replace(
            new RegExp(placeholder, 'g'),
            () => {
              // Remove `#hash` and `?#hash` from `require`
              const [normalizedUrl, singleQuery, hashValue] = url.split(
                /(\?)?#/
              );
              const hash =
                singleQuery || hashValue
                  ? `"${singleQuery ? '?' : ''}${
                      hashValue ? `#${hashValue}` : ''
                    }"`
                  : '';

              return `" + escape(require(${stringifyRequest(
                this,
                urlToRequest(normalizedUrl)
              )})${hash ? ` + ${hash}` : ''}) + "`;
            }
          );
        });

      if (exportCode) {
        exportCode = `exports.locals = ${exportCode};`;
      }

      let newMap = result.map;

      if (sourceMap && newMap) {
        // Add a SourceMap
        newMap = newMap.toJSON();

        if (newMap.sources) {
          newMap.sources = newMap.sources.map(
            (source) =>
              source
                .split('!')
                .pop()
                .replace(/\\/g, '/'),
            this
          );
          newMap.sourceRoot = '';
        }

        newMap.file = newMap.file
          .split('!')
          .pop()
          .replace(/\\/g, '/');
        newMap = JSON.stringify(newMap);
      }

      const runtimeCode = `exports = module.exports = require(${stringifyRequest(
        this,
        require.resolve('./runtime/api')
      )})(${!!sourceMap});`;
      const moduleCode = `exports.push([module.id, ${cssAsString}, ""${
        newMap ? `,${newMap}` : ''
      }]);`;

      // Embed runtime
      return callback(
        null,
        `${urlEscapeHelperCode}${runtimeCode}\n` +
          `// imports\n${importCode}\n\n` +
          `// module\n${moduleCode}\n\n` +
          `// exports\n${exportCode}`
      );
    })
    .catch((error) => {
      callback(
        error.name === 'CssSyntaxError' ? new CssSyntaxError(error) : error
      );
    });
}