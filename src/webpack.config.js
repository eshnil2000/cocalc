/* 
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: AGPLv3 s.t. "Commons Clause" – see LICENSE.md for details
 */

/*
 * CoCalc, by SageMath, Inc., (c) 2016, 2017 -- License: AGPLv3
 */

/*
* Webpack configuration file

Run dev server with source maps:

    npm run webpack-watch

Then visit (say)

    https://dev0.sagemath.com/

or for smc-in-smc project, info.py URL, e.g.

    https://cocalc.com/14eed217-2d3c-4975-a381-b69edcb40e0e/port/56754/

This is far from ready to use yet, e.g., we need to properly serve primus websockets, etc.:

    webpack-dev-server --port=9000 -d

Resources for learning webpack:

    - https://github.com/petehunt/webpack-howto
    - http://webpack.github.io/docs/tutorials/getting-started/

---

*# Information for developers

This webpack config file might look scary, but it only consists of a few moving parts.

1. There is the "main" SMC application, which is split into "css", "lib" and "smc":
   1. css: a collection of all static styles from various locations. It might be possible
      to use the text extraction plugin to make this a .css file, but that didn't work out.
      Some css is inserted, but it doesn't work and no styles are applied. In the end,
      it doesn't matter to load it one way or the other. Furthermore, as .js is even better,
      because the initial page load is instant and doesn't require to get the compiled css styles.
   2. lib: this is a compilation of the essential js files in webapp-lib (via webapp-lib.js)
   3. smc: the core smc library. besides this, there are also chunks ([number]-hash.js) that are
      loaded later on demand (read up on `require.ensure`).
      For example, such a chunkfile contains latex completions, the data for the wizard, etc.
2. There are static html files for the policies.
   The policy files originate in webapp-lib/policies, where at least one file is generated by update_react_static.
   That script runs part of the smc application in node.js to render to html.
   Then, that html output is included into the html page and compiled.
   It's not possible to automate this fully, because during the processing of these templates,
   the "css" chunk from point 1.1 above is injected, too.
   In the future, also other elements from the website (e.g. <Footer/>) will be rendered as
   separate static html template elements and included there.
3. There are auxiliary files for the "video chat" functionality. That might be redone differently, but
   for now rendering to html only works via the html webpack plugin in such a way,
   that it rewrites paths and post processes the files correctly to work.

The remaining configuration deals with setting up variables (misc_node contains the centralized
information about where the page is getting rendered to, because also the hub.coffee needs to know
about certain file locations)

Development vs. Production: There are two variables DEVMODE and PRODMODE.
* Prodmode:
  * additional compression is enabled (do *not* add the -p switch to webpack, that's done here explicitly!)
  * all output filenames, except for the essential .html files, do have hashes and a rather flat hierarchy.
* Devmode:
  * Apply as little additional plugins as possible (compiles faster).
  * File names have no hashes, or hashes are deterministically based on the content.
    This means, when running webpack-watch, you do not end up with a growing pile of
    thousands of files in the output directory.

MathJax: It lives in its own isolated world. This means, don't mess with the MathJax.js ...
It needs to know from where it is loaded (the path in the URL), to retrieve many additional files on demand.
That's also the main reason why it is slow, because for each file a new SSL connection has to be setup!
(unless, http/2 or spdy do https pipelining).
How do we help MathJax a little bit by caching it, when the file names aren't hashed?
The trick is to add the MathJax version number to the path, such that it is unique and will definitely
trigger a reload after an update of MathJax.
The MathjaxVersionedSymlink below (in combination with misc_node.MATHJAX_LIB)
does extract the MathJax version number, computes the path, and symlinks to its location.
Why in misc_node? The problem is, that also the jupyter server (in its isolated iframe),
needs to know about the MathJax URL.
That way, the hub can send down the URL to the jupyter server (there is no webapp client in between).
*/

"use strict";

// So we can require coffeescript code.
require("coffeescript/register");
// So we can require Typescript code.
require("ts-node").register();

let cleanWebpackPlugin, entries, hashname, MATHJAX_URL, output_fn, publicPath;
const plugins = [];
const _ = require("lodash");
const webpack = require("webpack");
const path = require("path");
const fs = require("fs");
const glob = require("glob");
const child_process = require("child_process");
const misc = require("smc-util/misc");
const misc_node = require("smc-util-node/misc_node");
const async = require("async");
const program = require("commander");

const SMC_VERSION = require("smc-util/smc-version").version;
const theme = require("smc-util/theme");

const git_head = child_process.execSync("git rev-parse HEAD");
const GIT_REV = git_head.toString().trim();
const TITLE = theme.SITE_NAME;
const DESCRIPTION = theme.APP_TAGLINE;
const SMC_REPO = "https://github.com/sagemathinc/cocalc";
const SMC_LICENSE = "AGPLv3";
const { WEBAPP_LIB } = misc_node;
const INPUT = path.resolve(__dirname, WEBAPP_LIB);
const OUTPUT = path.resolve(__dirname, misc_node.OUTPUT_DIR);
const DEVEL = "development";
const NODE_ENV = process.env.NODE_ENV || DEVEL;
const { NODE_DEBUG } = process.env;
const PRODMODE = NODE_ENV !== DEVEL;
const COMP_ENV =
  (process.env.CC_COMP_ENV || PRODMODE) &&
  fs.existsSync("webapp-lib/compute-components.json");
let { CDN_BASE_URL } = process.env; // CDN_BASE_URL must have a trailing slash
const DEVMODE = !PRODMODE;
const MINIFY = !!process.env.WP_MINIFY;
const DEBUG = process.argv.includes("--debug");
const { MEASURE } = process.env;
const SOURCE_MAP = !!process.env.SOURCE_MAP;
const date = new Date();
const BUILD_DATE = date.toISOString();
const BUILD_TS = date.getTime();
const { GOOGLE_ANALYTICS } = misc_node;
const CC_NOCLEAN = !!process.env.CC_NOCLEAN;

// If True, do not run typescript compiler at all. Fast,
// but obviously less safe.  This is designed for use, e.g.,
// when trying to do a quick production build in an emergency,
// when we already know the typescript all works.
const TS_TRANSPILE_ONLY = !!process.env.TS_TRANSPILE_ONLY;

// When building the static page or if the user explicitly sets
// an env variable, we do not want to use the forking typescript
// module instead.
const DISABLE_TS_LOADER_OPTIMIZATIONS =
  !!process.env.DISABLE_TS_LOADER_OPTIMIZATIONS ||
  PRODMODE ||
  TS_TRANSPILE_ONLY;

// create a file base_url to set a base url
const { BASE_URL } = misc_node;

// check and sanitiziation (e.g. an exising but empty env variable is ignored)
// CDN_BASE_URL must have a trailing slash
if (CDN_BASE_URL == null || CDN_BASE_URL.length === 0) {
  CDN_BASE_URL = null;
} else {
  if (CDN_BASE_URL.slice(-1) !== "/") {
    throw new Error(
      `CDN_BASE_URL must be an URL-string ending in a '/' -- but it is ${CDN_BASE_URL}`
    );
  }
}

// output build environment variables of webpack
console.log(`SMC_VERSION      = ${SMC_VERSION}`);
console.log(`SMC_GIT_REV      = ${GIT_REV}`);
console.log(`NODE_ENV         = ${NODE_ENV}`);
console.log(`NODE_DEBUG       = ${NODE_DEBUG}`);
console.log(`COMP_ENV         = ${COMP_ENV}`);
console.log(`BASE_URL         = ${BASE_URL}`);
console.log(`CDN_BASE_URL     = ${CDN_BASE_URL}`);
console.log(`DEBUG            = ${DEBUG}`);
console.log(`MINIFY           = ${MINIFY}`);
console.log(`MEASURE          = ${MEASURE}`);
console.log(`INPUT            = ${INPUT}`);
console.log(`OUTPUT           = ${OUTPUT}`);
console.log(`GOOGLE_ANALYTICS = ${GOOGLE_ANALYTICS}`);
console.log(`CC_NOCLEAN       = ${CC_NOCLEAN}`);
console.log(`TS_TRANSPILE_ONLY= ${TS_TRANSPILE_ONLY}`);
console.log(
  `DISABLE_TS_LOADER_OPTIMIZATIONS = ${DISABLE_TS_LOADER_OPTIMIZATIONS}`
);

// mathjax version → symlink with version info from package.json/version
if (CDN_BASE_URL != null) {
  // the CDN url does not have the /static/... prefix!
  MATHJAX_URL =
    CDN_BASE_URL + path.join(misc_node.MATHJAX_SUBDIR, "MathJax.js");
} else {
  ({ MATHJAX_URL } = misc_node); // from where the files are served
}
const { MATHJAX_ROOT } = misc_node; // where the symlink originates
const { MATHJAX_LIB } = misc_node; // where the symlink points to
console.log(`MATHJAX_URL      = ${MATHJAX_URL}`);
console.log(`MATHJAX_ROOT     = ${MATHJAX_ROOT}`);
console.log(`MATHJAX_LIB      = ${MATHJAX_LIB}`);

// fallback case: if COMP_ENV is false (default) we still need empty json files to satisfy the webpack dependencies
if (!COMP_ENV) {
  for (let fn of [
    "webapp-lib/compute-components.json",
    "webapp-lib/compute-inventory.json",
  ]) {
    if (fs.existsSync(fn)) {
      continue;
    }
    fs.writeFileSync(fn, "{}");
  }
}

// adds a banner to each compiled and minified source .js file
// webpack2: https://webpack.js.org/guides/migrating/#bannerplugin-breaking-change
const banner = new webpack.BannerPlugin({
  banner: `\
This file is part of ${TITLE}.
It was compiled ${BUILD_DATE} at revision ${GIT_REV} and version ${SMC_VERSION}.
See ${SMC_REPO} for its ${SMC_LICENSE} code.\
`,
  entryOnly: true,
});

// webpack plugin to do the linking after it's "done"
class MathjaxVersionedSymlink {
  apply(compiler) {
    // make absolute path to the mathjax lib (lives in node_module of smc-webapp)
    const symto = path.resolve(__dirname, `${MATHJAX_LIB}`);
    console.log(`mathjax symlink: pointing to ${symto}`);
    const mksymlink = (dir, cb) =>
      fs.access(dir, function (err) {
        if (err) {
          fs.symlink(symto, dir, cb);
        }
      });
    const done = (compilation) =>
      async.concat([MATHJAX_ROOT, misc_node.MATHJAX_NOVERS], mksymlink);
    const plugin = { name: "MathjaxVersionedSymlink" };
    compiler.hooks.done.tap(plugin, done);
  }
}

const mathjaxVersionedSymlink = new MathjaxVersionedSymlink();

if (!CC_NOCLEAN) {
  // cleanup like "make distclean"
  // otherwise, compiles create an evergrowing pile of files
  const CleanWebpackPlugin = require("clean-webpack-plugin");
  cleanWebpackPlugin = new CleanWebpackPlugin([OUTPUT], {
    verbose: true,
    dry: false,
  });
}

// assets.json file
const AssetsPlugin = require("assets-webpack-plugin");
const assetsPlugin = new AssetsPlugin({
  path: OUTPUT,
  filename: "assets.json",
  fullPath: false,
  prettyPrint: true,
  metadata: {
    git_ref: GIT_REV,
    version: SMC_VERSION,
    built: BUILD_DATE,
    timestamp: BUILD_TS,
  },
});

// https://www.npmjs.com/package/html-webpack-plugin
const HtmlWebpackPlugin = require("html-webpack-plugin");
// we need our own chunk sorter, because just by dependency doesn't work
// this way, we can be 100% sure
function smcChunkSorter(a, b) {
  const order = ["css", "fill", "vendor", "smc"];
  if (order.indexOf(a.names[0]) < order.indexOf(b.names[0])) {
    return -1;
  } else {
    return 1;
  }
}

// https://github.com/kangax/html-minifier#options-quick-reference
const htmlMinifyOpts = {
  empty: true,
  removeComments: true,
  minifyJS: true,
  minifyCSS: true,
  collapseWhitespace: true,
  conservativeCollapse: true,
};

// when base_url_html is set, it is hardcoded into the index page
// it mimics the logic of the hub, where all trailing slashes are removed
// i.e. the production page has a base url of '' and smc-in-smc has '/.../...'
let base_url_html = BASE_URL; // do *not* modify BASE_URL, it's needed with a '/' down below
while (base_url_html && base_url_html[base_url_html.length - 1] === "/") {
  base_url_html = base_url_html.slice(0, base_url_html.length - 1);
}

// this is the main app.html file, which should be served without any caching
// config: https://github.com/jantimon/html-webpack-plugin#configuration
const pug2app = new HtmlWebpackPlugin({
  date: BUILD_DATE,
  title: TITLE,
  description: DESCRIPTION,
  BASE_URL: base_url_html,
  theme,
  COMP_ENV,
  components: {}, // no data needed, empty is fine
  inventory: {}, // no data needed, empty is fine
  git_rev: GIT_REV,
  mathjax: MATHJAX_URL,
  filename: "app.html",
  chunksSortMode: smcChunkSorter,
  inject: "body",
  hash: PRODMODE,
  template: path.join(INPUT, "app.pug"),
  minify: htmlMinifyOpts,
  GOOGLE_ANALYTICS,
});

// global css loader configuration
const cssConfig = JSON.stringify({
  sourceMap: false,
});

// this is like C's #ifdef for the source code. It is particularly useful in the
// source code of CoCalc's webapp, such that it knows about itself's version and where
// mathjax is. The version&date is shown in the hover-title in the footer (year).
const setNODE_ENV = new webpack.DefinePlugin({
  "process.env": {
    NODE_ENV: JSON.stringify(NODE_ENV),
  },
  MATHJAX_URL: JSON.stringify(MATHJAX_URL),
  SMC_VERSION: JSON.stringify(SMC_VERSION),
  SMC_GIT_REV: JSON.stringify(GIT_REV),
  BUILD_DATE: JSON.stringify(BUILD_DATE),
  BUILD_TS: JSON.stringify(BUILD_TS),
  DEBUG: JSON.stringify(DEBUG),
});

// Writes a JSON file containing the main webpack-assets and their filenames.
const { StatsWriterPlugin } = require("webpack-stats-plugin");
const statsWriterPlugin = new StatsWriterPlugin({
  filename: "webpack-stats.json",
});

// https://webpack.js.org/guides/migrating/#uglifyjsplugin-minimize-loaders
const loaderOptions = new webpack.LoaderOptionsPlugin({
  minimize: true,
  options: {
    "html-minify-loader": {
      empty: true, // KEEP empty attributes
      cdata: true, // KEEP CDATA from scripts
      comments: false,
      removeComments: true,
      minifyJS: true,
      minifyCSS: true,
      collapseWhitespace: true,
      conservativeCollapse: true,
    },
  }, // absolutely necessary, also see above in module.loaders/.html
  //sassLoader:
  //    includePaths: [path.resolve(__dirname, 'src', 'scss')]
  //context: '/'
});

if (cleanWebpackPlugin != null) {
  plugins.push(cleanWebpackPlugin);
}

plugins.push(...[setNODE_ENV, banner, loaderOptions]);

// ATTN don't alter or add names here, without changing the sorting function above!
entries = {
  css: "webapp-css.js",
  fill: "@babel/polyfill",
  smc: "webapp-cocalc.js",
  // code splitting: we take all of our vendor code and put it in a separate bundle (vendor.min.js)
  // this way it will have better caching/cache hits since it changes infrequently
  vendor: [
    // local packages
    "./webapp-lib/primus/primus-engine.min.js",
    // npm packages are added to vendor code separately in splitChunks config below
  ],
  "pdf.worker": "./smc-webapp/node_modules/pdfjs-dist/build/pdf.worker.entry",
};
plugins.push(...[pug2app, mathjaxVersionedSymlink]);

if (!DISABLE_TS_LOADER_OPTIMIZATIONS) {
  console.log("Enabling ForkTsCheckerWebpackPlugin...");
  if (process.env.TSC_WATCHDIRECTORY == null || process.env.TSC_WATCHFILE) {
    console.log(
      "To workaround performance issues with the default typescript watch, we set TSC_WATCH* env vars:"
    );
    // See https://github.com/TypeStrong/fork-ts-checker-webpack-plugin/issues/236
    // This one seems to work well; others miss changes:
    process.env.TSC_WATCHFILE = "UseFsEventsOnParentDirectory";
    // Using "RecursiveDirectoryUsingFsWatchFile" for the directory is very inefficient on CoCalc.
    process.env.TSC_WATCHDIRECTORY =
      "RecursiveDirectoryUsingDynamicPriorityPolling";
  }

  const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");
  plugins.push(
    new ForkTsCheckerWebpackPlugin({
      // async false makes it much easy to see the error messages and
      // be aware of when compilation is done,
      // but is slower because it has to wait before showing them.
      // We still benefit from parallel computing though.
      // We could change this to async if there were some
      // better way to display that output is pending and that it appeared...
      // NOTE: it is very important to do
      //     TSC_WATCHFILE=UseFsEventsWithFallbackDynamicPolling
      // in package.json's watch. See
      //  https://blog.johnnyreilly.com/2019/05/typescript-and-high-cpu-usage-watch.html
      async: false,
      measureCompilationTime: true,
    })
  );
}

if (DEVMODE) {
  console.log(`\
******************************************************
*             You have to visit:                     *
*   https://cocalc.com/[project_id]/port/[...]/app   *
******************************************************`);
}

if (PRODMODE) {
  // configuration for the number of chunks and their minimum size
  plugins.push(new webpack.optimize.LimitChunkCountPlugin({ maxChunks: 5 }));
}

plugins.push(...[assetsPlugin, statsWriterPlugin]);

const UglifyJsPlugin = require("uglifyjs-webpack-plugin");
const minimizer = new UglifyJsPlugin({
  uglifyOptions: {
    output: {
      comments: new RegExp(`This file is part of ${TITLE}`, "g"),
    },
  },
}); // to keep the banner inserted above

// tuning generated filenames and the configs for the aux files loader.
// FIXME this setting isn't picked up properly
if (PRODMODE) {
  hashname = "[sha256:hash:base62:33].cacheme.[ext]"; // don't use base64, it's not recommended for some reason.
} else {
  hashname = "[path][name].nocache.[ext]";
}
const pngconfig = `name=${hashname}&limit=16000&mimetype=image/png`;
const svgconfig = `name=${hashname}&limit=16000&mimetype=image/svg+xml`;
const icoconfig = `name=${hashname}&mimetype=image/x-icon`;
const woffconfig = `name=${hashname}&mimetype=application/font-woff`;

// publicPath: either locally, or a CDN, see https://github.com/webpack/docs/wiki/configuration#outputpublicpath
// In order to use the CDN, copy all files from the `OUTPUT` directory over there.
// Caching: files ending in .html (like index.html or those in /policies/) and those matching '*.nocache.*' shouldn't be cached
//          all others have a hash and can be cached long-term (especially when they match '*.cacheme.*')
if (CDN_BASE_URL != null) {
  publicPath = CDN_BASE_URL;
} else {
  publicPath = path.join(BASE_URL, misc_node.OUTPUT_DIR) + "/";
}

if (MEASURE) {
  const { BundleAnalyzerPlugin } = require("webpack-bundle-analyzer");
  const bundleAnalyzerPlugin = new BundleAnalyzerPlugin({
    analyzerMode: "static",
  });
  plugins.push(...[bundleAnalyzerPlugin]);
}

module.exports = {
  cache: true,

  // https://webpack.js.org/configuration/devtool/#devtool
  // **do** use cheap-module-eval-source-map; it produces too large files, but who cares since we are not
  // using this in production.  DO NOT use 'source-map', which is VERY slow.
  devtool: SOURCE_MAP ? "#cheap-module-eval-source-map" : undefined,

  mode: PRODMODE ? "production" : "development",

  optimization: {
    minimizer: [minimizer],

    splitChunks: {
      cacheGroups: {
        commons: {
          test: /[\\/]node_modules[\\/]/,
          name: "vendor",
          chunks: "all",
        },
      },
    },
  },

  entry: entries,

  output: {
    path: OUTPUT,
    publicPath,
    filename: PRODMODE ? "[name]-[hash].cacheme.js" : "[name].nocache.js",
    chunkFilename: PRODMODE ? "[id]-[hash].cacheme.js" : "[id].nocache.js",
    hashFunction: "sha256",
  },

  module: {
    rules: [
      { test: /\.coffee$/, loader: "coffee-loader" },
      { test: /\.cjsx$/, loader: ["coffee-loader", "cjsx-loader"] },
      { test: [/node_modules\/prom-client\/.*\.js$/], loader: "babel-loader" },
      { test: [/latex-editor\/.*\.jsx?$/], loader: "babel-loader" },
      // Note: see https://github.com/TypeStrong/ts-loader/issues/552
      // for discussion of issues with ts-loader + webpack.
      {
        test: /\.tsx?$/,
        use: {
          loader: "ts-loader",
          options:
            TS_TRANSPILE_ONLY || DISABLE_TS_LOADER_OPTIMIZATIONS
              ? { transpileOnly: TS_TRANSPILE_ONLY } // run as normal or not at all
              : {
                  // do not run typescript checker in same process...
                  transpileOnly: !TS_TRANSPILE_ONLY,
                  experimentalWatchApi: true,
                },
        },
      },
      {
        test: /\.less$/,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              importLoaders: 2,
            },
          },
          "postcss-loader",
          `less-loader?${cssConfig}`,
        ],
      },
      {
        test: /\.scss$/i,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              importLoaders: 2,
            },
          },
          "postcss-loader",
          `sass-loader?${cssConfig}`,
        ],
      },
      {
        test: /\.sass$/i,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              importLoaders: 2,
            },
          },
          "postcss-loader",
          `sass-loader?${cssConfig}&indentedSyntax`,
        ],
      },
      { test: /\.png$/, loader: `file-loader?${pngconfig}` },
      { test: /\.ico$/, loader: `file-loader?${icoconfig}` },
      { test: /\.svg(\?[a-z0-9\.-=]+)?$/, loader: `url-loader?${svgconfig}` },
      { test: /\.(jpg|jpeg|gif)$/, loader: `file-loader?name=${hashname}` },
      {
        test: /\.html$/,
        include: [path.resolve(__dirname, "smc-webapp")],
        use: ["raw-loader", "html-minify-loader?conservativeCollapse"],
      },
      { test: /\.hbs$/, loader: "handlebars-loader" },
      {
        test: /\.woff(2)?(\?[a-z0-9\.-=]+)?$/,
        loader: `url-loader?${woffconfig}`,
      },
      {
        test: /\.ttf(\?[a-z0-9\.-=]+)?$/,
        loader: "url-loader?limit=10000&mimetype=application/octet-stream",
      },
      {
        test: /\.eot(\?[a-z0-9\.-=]+)?$/,
        loader: `file-loader?name=${hashname}`,
      },
      // ---
      {
        test: /\.css$/i,
        use: [
          "style-loader",
          {
            loader: "css-loader",
            options: {
              importLoaders: 1,
            },
          },
          "postcss-loader",
        ],
      },
      { test: /\.pug$/, loader: "pug-loader" },
    ],
  },

  resolve: {
    // So we can require('file') instead of require('file.coffee')
    extensions: [
      ".js",
      ".jsx",
      ".ts",
      ".tsx",
      ".json",
      ".coffee",
      ".cjsx",
      ".scss",
      ".sass",
    ],
    modules: [
      path.resolve(__dirname),
      path.resolve(__dirname, WEBAPP_LIB),
      path.resolve(__dirname, "smc-util"),
      path.resolve(__dirname, "smc-util/node_modules"),
      path.resolve(__dirname, "smc-webapp"),
      path.resolve(__dirname, "smc-webapp/node_modules"),
      path.resolve(__dirname, "node_modules"),
    ],
  },

  plugins,
};
