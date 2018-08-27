import {readFile, isFile, amazingCache} from './utils';
import path from 'path';
import bar from './helpers/progressBar';
import logger from './helpers/logger';
import {EventEmitter} from 'events';
import loader from './loader';
import COLOR from './const/color';
import debugPKG from 'debug';
import defaultPret from './const/defaultPret';
import wrapWxa from './helpers/wrapWxa';
import Compiler from './compilers/index';

/**
 * todo:
 *  1. full control compile task
 */
let count = 0;
let debug = debugPKG('WXA:Schedule');

class Schedule extends EventEmitter {
    constructor(src, dist, ext) {
        super();
        this.current = process.cwd();
        this.pending = [];
        this.waiting = [];
        this.finished = [];
        this.npmOrLocal = [];

        this.src = src || 'src';
        this.dist = dist || 'dist';
        this.wxaExt = ext || '.wxa';

        this.meta = {
            current: this.current,
            src: this.src,
            dist: this.dist,
            wxaExt: this.wxaExt,
            libSrc: path.join(__dirname, '../lib-dist'),
            libs: ['wxa_wrap.js'],
        };

        this.max = 5;

        this.bar = bar;
        this.logger = logger;
        this.mode = 'compile';
        this.wxaConfigs = {}; // wxa.config.js

        let wxaConfigs;
        Object.defineProperty(this, 'wxaConfigs', {
            get() {
                return wxaConfigs;
            },
            set(configs) {
                if (!configs.resolve || !configs.resolve.extensions) {
                    configs.resolve = {
                        extensions: ['.js', '.json'],
                        ...configs.resolve,
                    };
                }
                wxaConfigs = configs;
            },
        });

        this.$pageArray = []; // denpendencies
        this.$indexOfModule = []; // all module
        this.$isMountingCompiler = false; // if is mounting compiler, all task will be blocked.
    }

    set(name, value) {
        this[name] = value;
    }

    doDPA() {
        if (
            this.appConfigs == null ||
            !this.appConfigs.pages ||
            !this.appConfigs.pages.length
        ) {
            logger.errorNow('app页面配置缺失, 请检查app.json的pages配置项');
        }

        let pages = this.appConfigs.pages;
        // multi packages process.
        if (this.appConfigs.subPackages) {
            let subPages = this.appConfigs.subPackages.reduce((subPkgs, pkg)=>{
                return subPkgs.concat(pkg.pages.map((subpath)=>pkg.root+'/'+subpath));
            }, []);

            pages = pages.concat(subPages);
        }

        // pages spread
        let exts = ['.wxml', '.wxss', '.js', '.json'];
        pages.forEach((page)=>{
            // wxa file
            let wxaPage = path.join(this.current, this.src, page+this.meta.wxaExt);
            if (isFile(wxaPage)) {
                try {
                    this.$pageArray.push({
                        src: wxaPage,
                        sourceType: 'wxa',
                        category: 'Page',
                        pagePath: page,
                        pret: defaultPret,
                    });
                } catch (e) {
                    console.error(e);
                }
            } else {
                exts.forEach((ext)=>{
                    let p = path.join(this.current, this.src, page+ext);
                    if (isFile(p)) {
                        this.$pageArray.push({
                            src: p,
                            sourceType: ext,
                            category: 'Page',
                            pagePath: page,
                            pret: defaultPret,
                        });
                    }
                });
            }
        });
        console.log(this.$pageArray);

        if (!this.$pageArray.length) {
            logger.errorNow('找不到可编译的页面');
            return;
        }

        // lib compile
        let libs = this.meta.libs.map((file)=>{
            let libDep = {
                src: path.join(this.meta.current, this.meta.src, '_wxa', file),
                sourceType: 'js',
                $from: path.join(this.meta.libSrc, file),
                category: 'Lib',
                pret: defaultPret,
            };

            libDep.code = readFile(libDep.$from);

            return libDep;
        });

        this.$depPending = [].concat(libs, this.$pageArray);
        this.$indexOfModule = [].concat(libs, this.$pageArray);
        debug('depPending %o', this.$depPending);
        debug('DPA started');
        return this.$doDPA();
    }

    $doDPA() {
        let tasks = [];
        // while (this.$depPending.length) {
            let dep = this.$depPending.shift();

            debug('file to parse %O', dep);
            tasks.push(this.$parse(dep));
        // }

        return Promise.all(tasks).then((succ)=>{
            if (this.$depPending.length === 0) {
                // dependencies resolve complete
                return Promise.resolve(succ);
            } else {
                return this.$doDPA();
            }
        });
    }

    async $parse(dep) {
        // loader use custom compiler to load resource.
        await loader.compile(dep);

        // try to wrap wxa every app and page
        this.tryWrapWXA(dep);

        try {
            // Todo: conside if cache is necessary here.
            // let cacheParams = {
            //     source: code,
            //     options: {
            //         configs: {
            //             ast: true,
            //         },
            //     },
            //     transform: (code, options)=>{
            //         return compiler.parse(code, options.configs, dep.src, dep.sourceType || path.extname(dep.src));
            //     },
            // };
            debug('dep to process %O', dep);
            let compiler = new Compiler(this.wxaConfigs.resolve, this.meta);
            let childNodes = await compiler.parse(dep);

            debug('childNodes', childNodes);
            childNodes.forEach((node)=>this.findOrAddDependency(node, dep));

            dep.color = COLOR.COMPILED;
            // tick event
            this.emit('tick', dep);
        } catch (e) {
            // logger.errorNow('编译失败', e);
            debug('编译失败 %O', e);
        }
    }

    findOrAddDependency(dep, mdl) {
        // circle referrence.
        dep.reference = dep.reference || {};
        dep.reference.parent = mdl;

        // pret backup
        dep.pret = dep.pret || defaultPret;

        let indexedModule = this.$indexOfModule.find((module)=>module.src===dep.src);
        let child = {
            ...dep,
            color: COLOR.INIT,
            isNpm: dep.pret.isNodeModule,
            isPlugin: dep.pret.isPlugin,
            $target: dep.target,
            $pret: dep.pret,
        };

        if (indexedModule) {
            let ref = dep.reference;

            // merge from.
            if (Array.isArray(indexedModule.reference)) {
                indexedModule.reference.push(ref);
            } else if (typeof indexedModule.reference === 'object') {
                indexedModule.reference = [
                    indexedModule.reference,
                    ref,
                ];
            } else {
                indexedModule.reference = ref;
            }

            child = indexedModule;
        } else if (!child.isPlugin) {
            // plugin do not resolve dependencies.
            this.$depPending.push(child);
            this.$indexOfModule.push(child);
        }

        return child;
    }

    tryWrapWXA(dep) {
        if (dep.sourceType === 'wxa') return;

        if (
            ~['app', 'component', 'page'].indexOf(dep.category ? dep.category.toLowerCase() : '') &&
            dep.sourceType === 'js'
        ) {
            if (dep.code == null) dep.code= readFile(dep.src);

            if (dep.code == null) dep.code = '';

            dep.code = wrapWxa(dep.code, dep.category, dep.pagePath);
            debug('wrap dependencies %O', dep);
        }
    }
}
const schedule = new Schedule();

export default schedule;
