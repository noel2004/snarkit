"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compileCircuitDir = exports.WitnessGenerator = void 0;
const fs = require("fs");
const path = require("path");
const shelljs = require("shelljs");
const si = require('systeminformation');
const crypto = require('crypto');
const { stringifyBigInts, unstringifyBigInts } = require('ffjavascript').utils;
const { wtns } = require('snarkjs');
const crypto_1 = require("./crypto");
//import {compiler} from "circom";
//const Scalar = require("ffjavascript").Scalar;
const DEFAULT_NODE_ARGS = '--max-old-space-size=8192 --stack-size=65500';
const NODE_ARGS = process.env.NODE_ARGS || DEFAULT_NODE_ARGS;
const NODE_CMD = `node ${NODE_ARGS}`;
function isEmptyFile(filePath) {
    return !fs.existsSync(filePath) || fs.statSync(filePath).size == 0;
}
function shellExecFnBuilder(verbose) {
    function shellExec(cmd, options = {}) {
        if (verbose) {
            console.log(cmd);
        }
        return shelljs.exec(cmd, options);
    }
    return shellExec;
}
async function compileWasmBinary({ circuitDirName, r1csFilepath, circuitFilePath, symFilepath, binaryFilePath, verbose }) {
    const shellExec = shellExecFnBuilder(verbose);
    const circomcliPath = process.env.CIRCOM_CLI || path.join(require.resolve('circom'), '..', 'cli.js');
    let cmd;
    cmd = `${NODE_CMD} ${circomcliPath} ${circuitFilePath} -r ${r1csFilepath} -w ${binaryFilePath} -s ${symFilepath}`;
    if (verbose) {
        cmd = '/usr/bin/time ' + (process.platform === 'linux' ? '-v' : '-l') + ' ' + cmd;
        cmd += ' -v';
    }
    shellExec(cmd, { fatal: true });
    if (isEmptyFile(binaryFilePath)) {
        throw new Error('compile failed. ' + cmd);
    }
}
async function generateSrcsForNativeBinary({ circuitDirName, r1csFilepath, circuitFilePath, symFilepath, verbose, alwaysRecompile }) {
    const shellExec = shellExecFnBuilder(verbose);
    const circomRuntimePath = path.join(require.resolve('circom_runtime'), '..', '..');
    const ffiasmPath = path.join(require.resolve('ffiasm'), '..');
    const circomcliPath = process.env.CIRCOM_CLI || path.join(require.resolve('circom'), '..', 'cli.js');
    const cFilepath = path.join(circuitDirName, 'circuit.cpp');
    if (!alwaysRecompile && fs.existsSync(cFilepath) && fs.statSync(cFilepath).size > 0) {
        if (verbose) {
            console.log('skip generate c src', cFilepath);
        }
        return;
    }
    let cmd;
    cmd = `cp ${circomRuntimePath}/c/*.cpp ${circuitDirName}`;
    shellExec(cmd);
    cmd = `cp ${circomRuntimePath}/c/*.hpp ${circuitDirName}`;
    shellExec(cmd);
    cmd = `node ${ffiasmPath}/src/buildzqfield.js -q ${crypto_1.groupOrderPrimeStr} -n Fr`;
    shellExec(cmd, { cwd: circuitDirName });
    if (process.arch !== 'x64') {
        throw 'Unsupported platform ' + process.arch + '. Try wasm backend as an alternative';
    }
    if (process.platform === 'darwin') {
        cmd = `nasm -fmacho64 --prefix _  ${circuitDirName}/fr.asm`;
    }
    else if (process.platform === 'linux') {
        cmd = `nasm -felf64 ${circuitDirName}/fr.asm`;
    }
    else
        throw 'Unsupported platform';
    shellExec(cmd);
    cmd = `${NODE_CMD} ${circomcliPath} ${circuitFilePath} -r ${r1csFilepath} -c ${cFilepath} -s ${symFilepath}`;
    if (verbose) {
        cmd = '/usr/bin/time ' + (process.platform === 'linux' ? '-v' : '-l') + ' ' + cmd;
        cmd += ' -v';
    }
    shellExec(cmd, { fatal: true });
    if (isEmptyFile(cFilepath)) {
        throw new Error('compile failed. ' + cmd);
    }
    // the binary needs a $arg0.dat file, so we make a symbol link here
    cmd = `ln -s -f circuit.dat circuit.fast.dat`;
    shellExec(cmd, { cwd: circuitDirName });
}
async function compileNativeBinary({ circuitDirName, r1csFilepath, circuitFilePath, symFilepath, binaryFilePath, verbose, sanityCheck, alwaysRecompile, }) {
    await generateSrcsForNativeBinary({ circuitDirName, r1csFilepath, circuitFilePath, symFilepath, verbose, alwaysRecompile });
    const shellExec = shellExecFnBuilder(verbose);
    let compileCmd = `g++ ${circuitDirName}/main.cpp ${circuitDirName}/calcwit.cpp ${circuitDirName}/utils.cpp ${circuitDirName}/fr.cpp ${circuitDirName}/fr.o ${circuitDirName}/circuit.cpp -o ${binaryFilePath} -lgmp -std=c++11 -O3`;
    if (process.platform === 'darwin') {
        // do nothing
    }
    else if (process.platform === 'linux') {
        compileCmd += ' -pthread -fopenmp';
    }
    else {
        throw 'Unsupported platform';
    }
    if (sanityCheck) {
        compileCmd += ' -DSANITY_CHECK';
    }
    shellExec(compileCmd);
}
// Calculate md5 checksum for given set of src files.
function calculateSrcHashes(contents) {
    const hashes = new Map();
    for (const entry of Array.from(contents.entries())) {
        const checksum = crypto.createHash('md5').update(entry[1], 'utf8').digest('hex');
        hashes.set(entry[0], checksum);
    }
    return hashes;
}
// Load checksums of src files from last compile.
function loadOldSrcHashes(src) {
    const hashesFile = path.join(src, '..', 'srcs.sum');
    try {
        const jsonStr = fs.readFileSync(hashesFile, 'utf8');
        const hashes = new Map(JSON.parse(jsonStr));
        return hashes;
    }
    catch (err) {
        if (err.code !== 'ENOENT') {
            console.log('Load old src hash error:', err);
        }
        return null;
    }
}
// Write checksums of src files of this compile.
function writeSrcHashes(hashes, src) {
    const jsonStr = JSON.stringify(Array.from(hashes.entries()));
    const hashesFile = path.join(src, '..', 'srcs.sum');
    fs.writeFileSync(hashesFile, jsonStr, 'utf8');
}
// Check whether the checksums are equal between current src files and last compile.
function isSrcHashesEqual(srcHashes, oldSrcHashes) {
    let isEqual = true;
    for (const src of Array.from(srcHashes.keys())) {
        if (!oldSrcHashes.has(src)) {
            console.log('Added src file: ', src);
            isEqual = false;
        }
        else if (oldSrcHashes.get(src) !== srcHashes.get(src)) {
            console.log('Changed src file: ', src);
            isEqual = false;
        }
    }
    for (const src of Array.from(oldSrcHashes.keys())) {
        if (!srcHashes.has(src)) {
            console.log('Removed src file: ', src);
            isEqual = false;
        }
    }
    return isEqual;
}
// Check whether the src files are changed between this run and last compile.
function checkSrcChanged(src) {
    const circomDir = require.resolve('circom');
    const parser = require(path.join(circomDir, '..', 'parser/jaz.js')).parser;
    const srcContents = new Map();
    traverse(src);
    const srcHashes = calculateSrcHashes(srcContents);
    const oldSrcHashes = loadOldSrcHashes(src);
    if (oldSrcHashes == null || !isSrcHashesEqual(srcHashes, oldSrcHashes)) {
        writeSrcHashes(srcHashes, src);
        return true;
    }
    else {
        return false;
    }
    function traverse(src) {
        const content = fs.readFileSync(src, 'utf8');
        srcContents.set(src, content);
        const ast = parser.parse(content);
        for (const stat of ast.statements) {
            if (stat.type == 'INCLUDE') {
                let includedFile = stat.file;
                if (!path.isAbsolute(includedFile)) {
                    includedFile = path.normalize(path.join(src, '..', includedFile));
                }
                if (!srcContents.has(includedFile)) {
                    traverse(includedFile);
                }
            }
        }
    }
}
async function compileCircuitDir(circuitDirName, { alwaysRecompile, verbose, backend, sanityCheck }) {
    // console.log('compiling dir', circuitDirName);
    const circuitFilePath = path.join(circuitDirName, 'circuit.circom');
    const r1csFilepath = path.join(circuitDirName, 'circuit.r1cs');
    const symFilepath = path.join(circuitDirName, 'circuit.sym');
    let binaryFilePath;
    if (backend === 'native') {
        if (sanityCheck) {
            binaryFilePath = path.join(circuitDirName, 'circuit');
        }
        else {
            binaryFilePath = path.join(circuitDirName, 'circuit.fast');
        }
    }
    else {
        binaryFilePath = path.join(circuitDirName, 'circuit.wasm');
    }
    if (!alwaysRecompile &&
        fs.existsSync(binaryFilePath) &&
        fs.statSync(binaryFilePath).size > 0 &&
        checkSrcChanged(circuitFilePath) === false) {
        if (verbose) {
            console.log('skip compiling binary ', binaryFilePath);
        }
        return { circuitFilePath, r1csFilepath, symFilepath, binaryFilePath };
    }
    console.log('compile', circuitDirName);
    if (backend === 'native') {
        await compileNativeBinary({
            circuitDirName,
            r1csFilepath,
            circuitFilePath,
            symFilepath,
            binaryFilePath,
            verbose,
            sanityCheck,
            alwaysRecompile,
        });
    }
    else {
        // sanity check is not supported for wasm backend now
        await compileWasmBinary({ circuitDirName, r1csFilepath, circuitFilePath, symFilepath, binaryFilePath, verbose });
    }
    return { circuitFilePath, r1csFilepath, symFilepath, binaryFilePath };
}
exports.compileCircuitDir = compileCircuitDir;
class WitnessGenerator {
    constructor(name, { backend, alwaysRecompile, verbose, sanityCheck } = { backend: 'native', alwaysRecompile: true, verbose: false, sanityCheck: true }) {
        this.name = name;
        // we can specify cached files to avoid compiling every time
        this.alwaysRecompile = alwaysRecompile;
        this.verbose = verbose;
        this.backend = backend;
        this.sanityCheck = sanityCheck;
        if (this.verbose) {
            if (this.backend == 'wasm' && this.sanityCheck) {
                console.log('WARN: sanity check is not supported for wasm backend now');
            }
            console.log(`node: ${shelljs.which('node')} ${NODE_ARGS}`);
        }
    }
    async chooseBackend() {
        const needFeatures = ['bmi2', 'adx'];
        let cpuFeatures = (await si.cpu()).flags.split(/\s/);
        if (process.platform === 'darwin') {
            const stdout = shelljs.exec('sysctl machdep.cpu.leaf7_features', { silent: true });
            const features = stdout.trim().toLowerCase().split(/\s/).slice(1);
            cpuFeatures.push(...features);
        }
        for (const f of needFeatures) {
            if (!cpuFeatures.includes(f)) {
                console.log(`cpu missing needed feature ${f} for native backend, fallback to wasm`);
                console.log(`cpus earlier than Intel Boradwell / AMD Ryzen are not supported for native backend`);
                return 'wasm';
            }
        }
        return 'native';
    }
    async compile(circuitDirName) {
        this.circuitDirName = path.resolve(circuitDirName);
        if (this.backend === 'auto') {
            this.backend = await this.chooseBackend();
        }
        const { r1csFilepath, symFilepath, binaryFilePath } = await compileCircuitDir(this.circuitDirName, {
            alwaysRecompile: this.alwaysRecompile,
            verbose: this.verbose,
            backend: this.backend,
            sanityCheck: this.sanityCheck,
        });
        this.binaryFilePath = binaryFilePath;
        return { r1csFilepath, symFilepath };
    }
    async generateWitness(inputFilePath, witnessFilePath) {
        var cmd;
        if (this.binaryFilePath == '' || !fs.existsSync(this.binaryFilePath)) {
            throw new Error('invalid bin ' + this.binaryFilePath + '. Has the circuit been compiled?');
        }
        if (!witnessFilePath.endsWith('.json') && !witnessFilePath.endsWith('.wtns')) {
            throw new Error('invalid witness file type');
        }
        // gen witness
        if (this.backend === 'native') {
            cmd = `${this.binaryFilePath} ${inputFilePath} ${witnessFilePath}`;
            if (this.verbose) {
                console.log(cmd);
            }
            const genWtnsOut = shelljs.exec(cmd, { silent: !this.verbose });
            if (genWtnsOut.stderr || genWtnsOut.code != 0) {
                if (!this.verbose) {
                    // don't display stderr twice
                    console.error('\n' + genWtnsOut.stderr);
                }
                throw new Error('Could not generate witness');
            }
        }
        else {
            const snarkjsPath = path.join(require.resolve('snarkjs'), '..', 'cli.cjs');
            let witnessBinFile;
            if (witnessFilePath.endsWith('.json')) {
                witnessBinFile = witnessFilePath.replace(/json$/, 'wtns');
            }
            else {
                witnessBinFile = witnessFilePath;
            }
            // calculate witness bin file
            const sameProcess = true;
            if (sameProcess) {
                const input = unstringifyBigInts(JSON.parse(await fs.promises.readFile(inputFilePath, 'utf8')));
                await wtns.calculate(input, this.binaryFilePath, witnessBinFile, defaultWitnessOption());
            }
            else {
                cmd = `${NODE_CMD} ${snarkjsPath} wc ${this.binaryFilePath} ${inputFilePath} ${witnessBinFile}`;
                shelljs.exec(cmd);
            }
            // convert bin witness to json witness if needed
            if (witnessFilePath.endsWith('.json')) {
                cmd = `${NODE_CMD} ${snarkjsPath} wej ${witnessBinFile} ${witnessFilePath}`;
                shelljs.exec(cmd);
            }
        }
    }
}
exports.WitnessGenerator = WitnessGenerator;
function defaultWitnessOption() {
    let logFn = console.log;
    let calculateWitnessOptions = {
        sanityCheck: true,
        logTrigger: logFn,
        logOutput: logFn,
        logStartComponent: logFn,
        logFinishComponent: logFn,
        logSetSignal: logFn,
        logGetSignal: logFn,
    };
    return calculateWitnessOptions;
}
//# sourceMappingURL=witness_generator.js.map