'use strict';

import clone = require('clone');
import ELK = require('elkjs');
import _ = require('lodash');
import onml = require('onml');

const elk = new ELK();

type ICallback = (error: Error, result?: number) => void;

type Signals = Array<number | string>;

interface ModuleMap {
    [moduleName: string]: YosysModule;
}

interface YosysNetlist {
    modules: ModuleMap;
}

interface YosysModuleAttributes {
    top?: number;
    [attrName: string]: any;
}

interface CellAttributes {
    value?: string;
    [attrName: string]: any;
}

enum Direction {
    Input = 'input',
    Output = 'output',
}

enum WireDirection {
    Up, Down, Left, Right,
}

interface YosysExtPort {
    direction: Direction;
    bits: Signals;
}

interface YosysExtPortMap {
    [portName: string]: YosysExtPort;
}

interface YosysPortDirMap {
    [portName: string]: Direction;
}

interface YosysPortConnectionMap {
    [portName: string]: Signals;
}

interface YosysCell {
    type: string;
    port_directions: YosysPortDirMap;
    connections: YosysPortConnectionMap;
    attributes?: CellAttributes;
}

interface YosysCellMap {
    [cellName: string]: YosysCell;
}

interface YosysModule {
    ports: YosysExtPortMap;
    cells: YosysCellMap;
    attributes?: YosysModuleAttributes;
}

interface FlatPort {
    key: string;
    value?: number[] | Signals;
    parentNode?: Cell;
    wire?: Wire;
}

interface Cell {
    key: string;
    type: string;
    inputPorts: FlatPort[];
    outputPorts: FlatPort[];
    attributes?: CellAttributes;
}

interface Wire {
    drivers: FlatPort[];
    riders: FlatPort[];
    laterals: FlatPort[];
}

interface FlatModule {
    nodes: Cell[];
    wires: Wire[];
}

interface ElkGraph {
    id: string;
    children: ElkCell[];
    edges: ElkEdge[];
    width?: number;
    height?: number;
}

interface ElkPort {
    id: string;
    width: number;
    height: number;
    x?: number;
    y?: number;
    labels?: ElkLabel[];
}

interface ElkSegment {
    startPoint: WirePoint;
    endPoint: WirePoint;
    bendPoints: WirePoint[];
}

interface ElkEdge {
    id: string;
    source: string;
    sourcePort: string;
    target: string;
    targetPort: string;
    layoutOptions?: ElkLayoutOptions;
    junctionPoints?: WirePoint[];
    bendPoints?: WirePoint[];
    sections?: ElkSegment[];
}

interface ElkLayoutOptions {
    [option: string]: any;
}

interface ElkCell {
    id: string;
    width: number;
    height: number;
    ports: ElkPort[];
    layoutOptions?: ElkLayoutOptions;
    labels?: ElkLabel[];
    x?: number;
    y?: number;
}

interface ElkLabel {
    text: string;
    x: number;
    y: number;
    height: number;
    width: number;
}

interface WirePoint {
    x: number;
    y: number;
}

export function render(skinData: string, yosysNetlist: YosysNetlist, done?: ICallback) {
    const skin = onml.p(skinData);
    const layoutProps = getProperties(skin);

    // Find top module
    let moduleName: string = null;
    _.forEach(yosysNetlist.modules, (mod: YosysModule, name: string) => {
        if (mod.attributes && mod.attributes.top === 1) {
            moduleName = name;
        }
    });
    // Otherwise default the first one in the file...
    if (moduleName == null) {
        moduleName = Object.keys(yosysNetlist.modules)[0];
    }

    const module: FlatModule = getReformattedModule(yosysNetlist.modules[moduleName], skin);
    // this can be skipped if there are no 0's or 1's
    if (layoutProps.constants !== false) {
        addConstants(module);
    }
    // this can be skipped if there are no splits or joins
    if (layoutProps.splitsAndJoins !== false) {
        addSplitsJoins(module);
    }
    createWires(module, skin);
    const kgraph = buildKGraph(module, moduleName, skin);

    const promise = elk.layout(kgraph, { layoutOptions: layoutProps.layoutEngine })
        .then((g) => klayed_out(g, module, skin));

    // support legacy callback style
    if (typeof done === 'function') {
        promise.then((output) => {
            done(null, output);
            return output;
        }).catch(done);
    }

    return promise;
}

function getProperties(skin) {
    const properties: any[] = _.find(skin, (el) => {
        return el[0] === 's:properties';
    });
    const vals = _.mapValues(properties[1], (val) => {
        if (!isNaN(val)) {
            return Number(val);
        }
        if (val === 'true') {
            return true;
        }
        if (val === 'false') {
            return false;
        }
        return val;
    });
    const layoutEngine = _.find(properties, (el) => {
        return el[0] === 's:layoutEngine';
    }) || {};
    vals.layoutEngine = layoutEngine[1];
    return vals;
}

function which_dir(start: WirePoint, end: WirePoint): WireDirection {
    if (end.x === start.x && end.y === start.y) {
        throw new Error('start and end are the same');
    }
    if (end.x !== start.x && end.y !== start.y) {
        throw new Error('start and end arent orthogonal');
    }
    if (end.x > start.x) {
        return WireDirection.Right;
    }
    if (end.x < start.x) {
        return WireDirection.Left;
    }
    if (end.y > start.y) {
        return WireDirection.Down;
    }
    if (end.y < start.y) {
        return WireDirection.Up;
    }
    throw new Error('unexpected direction');
}

function removeDummyEdges(g: ElkGraph) {
    // go through each edge group for each dummy
    let dummyNum: number = 0;
    // loop until we can't find an edge group or we hit 10,000
    while (dummyNum < 10000) {
        const dummyId: string = '$d_' + String(dummyNum);
        // find all edges connected to this dummy
        const edgeGroup = _.filter(g.edges, (e) => {
            return e.source === dummyId || e.target === dummyId;
        });
        if (edgeGroup.length === 0) {
            break;
        }

        const junctEdge = _.minBy(edgeGroup, (e) => {
            if (e.source === dummyId) {
                if (e.junctionPoints) {
                    const firstJunction = e.junctionPoints[0];
                    return _.findIndex(e.bendPoints, (bend) => {
                        return bend.x === firstJunction.x && bend.y === firstJunction.y;
                    });
                }
                // a number bigger than any bendpoint index
                return 10000;
            } else {
                if (e.junctionPoints) {
                    const lastJunction = e.junctionPoints[e.junctionPoints.length - 1];
                    // flip the sign of the index so we find the max instead of the min
                    return 0 - _.findIndex(e.bendPoints, (bend) => {
                        return bend.x === lastJunction.x && bend.y === lastJunction.y;
                    });
                }
                // a number bigger than any bendpoint index
                return 1000;
            }
        });
        const junct = junctEdge.junctionPoints[0];

        const dirs: WireDirection[] = edgeGroup.map((e: ElkEdge) => {
            const s = e.sections[0];
            if (e.source === dummyId) {
                s.startPoint = junct;
                if (s.bendPoints) {
                    if (s.bendPoints[0].x === junct.x && s.bendPoints[0].y === junct.y) {
                        s.bendPoints = s.bendPoints.slice(1);
                    }

                    if (s.bendPoints.length > 0) {
                        return which_dir(junct, s.bendPoints[0]);
                    }
                }
                return which_dir(junct, s.endPoint);
            } else {
                s.endPoint = junct;
                if (s.bendPoints) {
                    const lastBend = s.bendPoints[s.bendPoints.length - 1];
                    if (lastBend.x === junct.x && lastBend.y === junct.y) {
                        s.bendPoints.pop();
                    }
                    if (s.bendPoints.length > 0) {
                        return which_dir(junct, s.bendPoints[s.bendPoints.length - 1]);
                    }
                }
                return which_dir(junct, s.startPoint);
            }
        });
        const dirSet = removeDups(dirs.map((wd) => WireDirection[wd]));
        if (dirSet.length === 2) {
            junctEdge.junctionPoints = junctEdge.junctionPoints.slice(1);
        }
        dummyNum += 1;
    }
}

function setTextAttribute(tempclone, attribute, value) {
    onml.traverse(tempclone, {
        enter: (node) => {
            if (node.name === 'text' && node.attr['s:attribute'] === attribute) {
                node.full[2] = value;
            }
        },
    });
}

function setGenericSize(tempclone, height) {
    onml.traverse(tempclone, {
        enter: (node) => {
            if (node.name === 'rect' && node.attr['s:generic'] === 'body') {
                node.attr.height = height;
            }
        },
    });
}

function klayed_out(g: ElkGraph, module: FlatModule, skinData) {
    const nodes = module.nodes.map((n: Cell) => {
        const kchild: ElkCell = _.find(g.children, (c) => c.id === n.key);
        const template = findSkinType(skinData, n.type);
        const tempclone = clone(template);
        setTextAttribute(tempclone, 'ref', n.key);
        if (n.attributes && n.attributes.value) {
            setTextAttribute(tempclone, 'name', n.attributes.value);
        }
        tempclone[1].transform = 'translate(' + kchild.x + ',' + kchild.y + ')';
        if (n.type === '$_constant_' && n.key.length > 3) {
            const num: number = parseInt(n.key, 2);
            setTextAttribute(tempclone, 'ref', '0x' + num.toString(16));
        } else if (n.type === '$_split_') {
            setGenericSize(tempclone, Number(getGenericHeight(template, n)));
            const outPorts = getPortsWithPrefix(template, 'out');
            const gap: number = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
            const startY: number = Number(outPorts[0][1]['s:y']);
            tempclone.pop();
            tempclone.pop();
            n.outputPorts.forEach((p, i) => {
                const portClone = clone(outPorts[0]);
                portClone[portClone.length - 1][2] = p.key;
                portClone[1].transform = 'translate(' + outPorts[1][1]['s:x'] + ','
                    + (startY + i * gap) + ')';
                tempclone.push(portClone);
            });
        } else if (n.type === '$_join_') {
            setGenericSize(tempclone, Number(getGenericHeight(template, n)));
            const inPorts = getPortsWithPrefix(template, 'in');
            const gap: number = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
            const startY: number = Number(inPorts[0][1]['s:y']);
            tempclone.pop();
            tempclone.pop();
            n.inputPorts.forEach((port, i) => {
                const portClone = clone(inPorts[0]);
                portClone[portClone.length - 1][2] = port.key;
                portClone[1].transform = 'translate(' + inPorts[1][1]['s:x'] + ','
                    + (startY + i * gap) + ')';
                tempclone.push(portClone);
            });
        } else if (template[1]['s:type'] === 'generic') {
            setGenericSize(tempclone, Number(getGenericHeight(template, n)));
            const inPorts = getPortsWithPrefix(template, 'in');
            const ingap = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
            const instartY = Number(inPorts[0][1]['s:y']);
            const outPorts = getPortsWithPrefix(template, 'out');
            const outgap = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
            const outstartY = Number(outPorts[0][1]['s:y']);
            tempclone.pop();
            tempclone.pop();
            tempclone.pop();
            tempclone.pop();
            n.inputPorts.forEach((port, i) => {
                const portClone = clone(inPorts[0]);
                portClone[portClone.length - 1][2] = port.key;
                portClone[1].transform = 'translate(' + inPorts[1][1]['s:x'] + ','
                    + (instartY + i * ingap) + ')';
                tempclone.push(portClone);
            });
            n.outputPorts.forEach((port, i) => {
                const portClone = clone(outPorts[0]);
                portClone[portClone.length - 1][2] = port.key;
                portClone[1].transform = 'translate(' + outPorts[1][1]['s:x'] + ','
                    + (outstartY + i * outgap) + ')';
                tempclone.push(portClone);
            });
            tempclone[2][2] = n.type;
        }
        return tempclone;
    });
    removeDummyEdges(g);
    const lines = _.flatMap(g.edges, (e: ElkEdge) => {
        return _.flatMap(e.sections, (s: ElkSegment) => {
            let startPoint = s.startPoint;
            s.bendPoints = s.bendPoints || [];
            const bends1: any[] = s.bendPoints.map((b) => {
                const l = ['line', {
                    x1: startPoint.x,
                    x2: b.x,
                    y1: startPoint.y,
                    y2: b.y,
                }];
                startPoint = b;
                return l;
            });
            const circles: any[] = e.junctionPoints.map((j: WirePoint) =>
                ['circle', { cx: j.x, cy: j.y, r: 2, style: 'fill:#000' }]);
            const bends = bends1.concat(circles);
            const line = [['line', {
                x1: startPoint.x,
                x2: s.endPoint.x,
                y1: startPoint.y,
                y2: s.endPoint.y,
            }]];
            return bends.concat(line);
        });
    });
    const svg = skinData.slice(0, 2);
    svg[1].width = g.width;
    svg[1].height = g.height;

    const styles = _.filter(skinData, (el) => {
        return el[0] === 'style';
    });
    const ret = svg.concat(styles).concat(nodes).concat(lines);
    return onml.s(ret);
}

function addDummy(children: ElkCell[], dummyNum: number) {
    const dummyId: string = '$d_' + String(dummyNum);
    const child: ElkCell = {
        id: dummyId,
        width: 0,
        height: 0,
        ports: [{
            id: dummyId + '.p',
            width: 0,
            height: 0,
        }],
        layoutOptions: { 'org.eclipse.elk.portConstraints': 'FIXED_SIDE' },
    };
    children.push(child);
    return dummyId;
}

function route(sourcePorts, targetPorts, i: number): ElkEdge[] {
    return _.flatMap(sourcePorts, (sourcePort) => {
        const sourceParentKey: string = sourcePort.parentNode.key;
        const sourceKey: string = sourceParentKey + '.' + sourcePort.key;
        return targetPorts.map((targetPort) => {
            const targetParentKey: string = targetPort.parentNode.key;
            const targetKey: string = targetParentKey + '.' + targetPort.key;
            const edge: ElkEdge = {
                id: 'e' + i,
                source: sourceParentKey,
                sourcePort: sourceKey,
                target: targetParentKey,
                targetPort: targetKey,
            };
            if (sourcePort.parentNode.type !== '$dff') {
                edge.layoutOptions = { 'org.eclipse.elk.layered.priority.direction': 10 };
            }
            i += 1;
            return edge;
        });
    });
}

function buildKGraph(module: FlatModule, moduleName: string, skinData): ElkGraph {
    const children: ElkCell[] = module.nodes.map((n) => {
        return buildKGraphChild(skinData, n);
    });
    let i: number = 0;
    let dummies: number = 0;
    const edges: ElkEdge[] = _.flatMap(module.wires, (w) => {
        // at least one driver and at least one rider and no laterals
        if (w.drivers.length > 0 && w.riders.length > 0 && w.laterals.length === 0) {
            const ret: ElkEdge[] = route(w.drivers, w.riders, i);
            return ret;
            // at least one driver or rider and at least one lateral
        } else if (w.drivers.concat(w.riders).length > 0 && w.laterals.length > 0) {
            const ret: ElkEdge[] = route(w.drivers, w.laterals, i).concat(route(w.laterals, w.riders, i));
            return ret;
            // at least two drivers and no riders
        } else if (w.riders.length === 0 && w.drivers.length > 1) {
            // create a dummy node and add it to children
            const dummyId: string = addDummy(children, dummies);
            dummies += 1;
            const dummyEdges: ElkEdge[] = w.drivers.map((driver) => {
                const sourceParentKey: string = driver.parentNode.key;
                const id: string = 'e' + String(i);
                i += 1;
                const d: ElkEdge = {
                    id,
                    source: sourceParentKey,
                    sourcePort: sourceParentKey + '.' + driver.key,
                    target: dummyId,
                    targetPort: dummyId + '.p',
                };
                return d;
            });
            return dummyEdges;
            // at least one rider and no drivers
        } else if (w.riders.length > 1 && w.drivers.length === 0) {
            // create a dummy node and add it to children
            const dummyId: string = addDummy(children, dummies);
            dummies += 1;
            const dummyEdges: ElkEdge[] = w.riders.map((rider) => {
                const sourceParentKey: string = rider.parentNode.key;
                const id: string = 'e' + String(i);
                i += 1;
                const edge: ElkEdge = {
                    id,
                    source: dummyId,
                    sourcePort: dummyId + '.p',
                    target: sourceParentKey,
                    targetPort: sourceParentKey + '.' + rider.key,
                };
                return edge;
            });
            return dummyEdges;
        } else if (w.laterals.length > 1) {
            const source = w.laterals[0];
            const sourceParentKey: string = source.parentNode.key;
            const lateralEdges: ElkEdge[] = w.laterals.slice(1).map((lateral) => {
                const lateralParentKey: string = lateral.parentNode.key;
                const id: string = 'e' + String(i);
                i += 1;
                const edge: ElkEdge = {
                    id,
                    source: sourceParentKey,
                    sourcePort: sourceParentKey + '.' + source.key,
                    target: lateralParentKey,
                    targetPort: lateralParentKey + '.' + lateral.key,
                };
                return edge;
            });
            return lateralEdges;
        }
        // for only one driver or only one rider, don't create any edges
        return [];
    });
    return {
        id: moduleName,
        children,
        edges,
    };
}

function getGenericHeight(template, node) {
    const inPorts = getPortsWithPrefix(template, 'in');
    const outPorts = getPortsWithPrefix(template, 'out');
    if (node.inputPorts.length > node.outputPorts.length) {
        const gap = Number(inPorts[1][1]['s:y']) - Number(inPorts[0][1]['s:y']);
        return Number(template[1]['s:height']) + gap * (node.inputPorts.length - 2);
    }
    if (outPorts.length > 1) {
        const gap = Number(outPorts[1][1]['s:y']) - Number(outPorts[0][1]['s:y']);
        return Number(template[1]['s:height']) + gap * (node.outputPorts.length - 2);
    }
    return Number(template[1]['s:height']);
}

function getPortsWithPrefix(template: any[], prefix: string) {
    const ports = _.filter(template, (e) => {
        if (e instanceof Array && e[0] === 'g') {
            return e[1]['s:pid'].startsWith(prefix);
        }
    });
    return ports;
}

function filterPortPids(template, filter) {
    const ports = _.filter(template, (element: any[]) => {
        const tag: string = element[0];
        if (element instanceof Array && tag === 'g') {
            const attrs: any = element[1];
            return filter(attrs);
        }
        return false;
    });
    return ports.map((port) => {
        return port[1]['s:pid'];
    });
}

function getLateralPortPids(template) {
    return filterPortPids(template, (attrs) => {
        if (attrs['s:dir']) {
            return attrs['s:dir'] === 'lateral';
        }
        if (attrs['s:position']) {
            return attrs['s:position'] === 'left' ||
                attrs['s:position'] === 'right';
        }
        return false;
    });
}

function getInputPortPids(template) {
    return filterPortPids(template, (attrs) => {
        if (attrs['s:position']) {
            return attrs['s:position'] === 'left' ||
                attrs['s:position'] === 'top';
        }
        return false;
    });
}

function getOutputPortPids(template) {
    return filterPortPids(template, (attrs) => {
        if (attrs['s:position']) {
            return attrs['s:position'] === 'right' ||
                attrs['s:position'] === 'bottom';
        }
        return false;
    });
}

function getGenericPortsFrom(nports: FlatPort[], templatePorts, nkey: string, type: string, dir: string): ElkPort[] {
    return nports.map((p: FlatPort, i: number) => {

        if (i === 0) {
            const ret: ElkPort = {
                id: nkey + '.' + p.key,
                width: 1,
                height: 1,
                x: Number(templatePorts[0][1]['s:x']),
                y: Number(templatePorts[0][1]['s:y']),
            };

            if ((type === 'generic' || type === 'join') && dir === 'in') {
                ret.labels = [{
                    text: p.key,
                    x: Number(templatePorts[0][2][1].x),
                    y: Number(templatePorts[0][2][1].y),
                    width: (6 * p.key.length),
                    height: 11,
                }];
            }

            if ((type === 'generic' || type === 'split') && dir === 'out') {
                ret.labels = [{
                    text: p.key,
                    x: Number(templatePorts[0][2][1].x),
                    y: Number(templatePorts[0][2][1].y),
                    width: (6 * p.key.length),
                    height: 11,
                }];
            }
            return ret;
        } else {
            const gap: number = Number(templatePorts[1][1]['s:y']) - Number(templatePorts[0][1]['s:y']);
            const ret: ElkPort = {
                id: nkey + '.' + p.key,
                width: 1,
                height: 1,
                x: Number(templatePorts[0][1]['s:x']),
                y: (i) * gap + Number(templatePorts[0][1]['s:y']),
            };
            if (type === 'generic') {
                ret.labels = [{
                    text: p.key,
                    x: Number(templatePorts[0][2][1].x),
                    y: Number(templatePorts[0][2][1].y),
                    width: (6 * p.key.length),
                    height: 11,
                }];
            }
            return ret;
        }
    });
}

// given a module type, build kgraphchild
function buildKGraphChild(skinData, n: Cell): ElkCell {
    //   labels: [ { text: "n2" } ],
    const template = findSkinType(skinData, n.type);
    const type: string = template[1]['s:type'];
    if (type === 'join' ||
        type === 'split' ||
        type === 'generic') {
        const inPorts: string[] = getPortsWithPrefix(template, 'in');
        const outPorts: string[] = getPortsWithPrefix(template, 'out');
        const allPorts: ElkPort[] = getGenericPortsFrom(n.inputPorts,
            inPorts,
            n.key,
            type,
            'in').concat(
                getGenericPortsFrom(n.outputPorts,
                    outPorts,
                    n.key,
                    type,
                    'out'));
        const cell: ElkCell = {
            id: n.key,
            width: Number(template[1]['s:width']),
            height: Number(getGenericHeight(template, n)),
            ports: allPorts,
            layoutOptions: { 'de.cau.cs.kieler.portConstraints': 'FIXED_POS' },
        };
        if (type === 'generic') {
            cell.labels = [{
                text: n.type,
                x: Number(template[2][1].x),
                y: Number(template[2][1].y),
                height: 11,
                width: (6 * n.type.length),
            }];
        }
        return cell;
    }
    const ports: ElkPort[] = getPortsWithPrefix(template, '').map((p) => {
        return {
            id: n.key + '.' + p[1]['s:pid'],
            width: 0,
            height: 0,
            x: Number(p[1]['s:x']),
            y: Number(p[1]['s:y']),
        };
    });
    const nodeWidth: number = Number(template[1]['s:width']);
    const ret: ElkCell = {
        id: n.key,
        width: nodeWidth,
        height: Number(template[1]['s:height']),
        ports,
        layoutOptions: { 'de.cau.cs.kieler.portConstraints': 'FIXED_POS' },
    };
    if (type === 'inputExt' ||
        type === 'outputExt') {
        ret.labels = [{
            text: n.key,
            x: Number(template[2][1].x) + nodeWidth / 2 - 3 * n.key.length,
            y: Number(template[2][1].y),
            height: 11,
            width: (6 * n.key.length),
        }];
    }
    return ret;
}

function findSkinType(skinData, type: string) {
    let ret = null;
    onml.traverse(skinData, {
        enter: (node, parent) => {
            if (node.name === 's:alias' && node.attr.val === type) {
                ret = parent;
            }
        },
    });
    if (ret == null) {
        onml.traverse(skinData, {
            enter: (node) => {
                if (node.attr['s:type'] === 'generic') {
                    ret = node;
                }
            },
        });
    }
    return ret.full;
}

function toCellArray(assoc: YosysCellMap | YosysExtPortMap): Cell[] {
    return _.flatMap(assoc, (val: YosysCell, key: string) => {
        const c: Cell = {
            key,
            type: val.type,
            inputPorts: [],
            outputPorts: [],
        };
        if (val.attributes) {
            c.attributes = val.attributes;
        }
        return c;
    });
}

// returns an array of ports that are going a specific direction
// the elements in this array are obects whose members are key and value
// where key is the port name and value is the connection array
function getCellPortList(cell: YosysCell, direction: Direction) {
    const ports = _.filter(_.flatMap(cell.connections, (val, key) => {
        return { key, value: val };
    }), (val) => {
        return cell.port_directions[val.key] === direction;
    });
    return ports;
}

// returns a reformatted module
// a flat module has a list of nodes that include all input and output ports
function getReformattedModule(module: YosysModule, skin): FlatModule {
    const ports: Cell[] = toCellArray(module.ports);
    // convert external inputs to cells
    const inputPorts: Cell[] = _.filter(ports, (p: Cell, i: number) => {
        const yp: YosysExtPort = module.ports[i];
        const isInput: boolean = yp.direction === Direction.Input;
        if (isInput) {
            p.inputPorts = [];
            p.outputPorts = [{ key: 'Y', value: yp.bits }];
        }
        return isInput;
    });
    // convert external outputs to cells
    const outputPorts: Cell[] = _.filter(ports, (p, i) => {
        const yp: YosysExtPort = module.ports[i];
        const isOutput = yp.direction === Direction.Output;
        if (isOutput) {
            p.inputPorts = [{ key: 'A', value: yp.bits }];
            p.outputPorts = [];
        }
        return isOutput;
    });
    const mcells: Cell[] = toCellArray(module.cells);
    inputPorts.forEach((p) => { p.type = '$_inputExt_'; });
    outputPorts.forEach((p) => { p.type = '$_outputExt_'; });
    mcells.forEach((c: Cell, i: number) => {
        const yc: YosysCell = module.cells[i];
        const template = findSkinType(skin, c.type);
        if (!yc.port_directions) {
            yc.port_directions = {};
        }
        getInputPortPids(template).forEach((pid) => {
            yc.port_directions[pid] = Direction.Input;
        });
        getOutputPortPids(template).forEach((pid) => {
            yc.port_directions[pid] = Direction.Output;
        });
        c.inputPorts = getCellPortList(yc, Direction.Input);
        c.outputPorts = getCellPortList(yc, Direction.Output);
    });
    const flatModule: FlatModule = {
        nodes:
            inputPorts.concat(outputPorts).concat(mcells),
        wires: [],
    };
    return flatModule;
}

interface SigsByConstName {
    [constantName: string]: number[];
}

function assignConstant(nameCollector: string,
                        constants: number[],
                        currIndex: number,
                        signalsByConstantName: SigsByConstName,
                        portSignals: Signals,
                        module: FlatModule) {
    // we've been appending to nameCollector, so reverse to get const name
    const constName = nameCollector.split('').reverse().join('');
    // if the constant has already been used
    if (signalsByConstantName.hasOwnProperty(constName)) {
        const constSigs: number[] = signalsByConstantName[constName];
        // go back and fix signal values
        const constLength = constSigs.length;
        constSigs.forEach((constSig, constIndex) => {
            // i is where in port_signals we need to update
            const i: number = currIndex - constLength + constIndex;
            portSignals[i] = constSig;
        });
    } else {
        const constant: Cell = {
            key: constName,
            type: '$_constant_',
            inputPorts: [],
            outputPorts: [{ key: 'Y', value: constants }],
        };
        module.nodes.push(constant);
        signalsByConstantName[constName] = constants;
    }
}

// converts input ports with constant assignments to constant nodes
function addConstants(module: FlatModule) {
    // find the maximum signal number
    let maxNum: number = -1;
    module.nodes.forEach((n) => {
        n.outputPorts.forEach((p) => {
            const maxVal: number = _.max(_.map(p.value, (v) => {
                return Number(v);
            }));
            maxNum = _.max([maxNum, maxVal]);
        });
    });

    // add constants to nodes
    const signalsByConstantName: SigsByConstName = {};
    module.nodes.forEach((n) => {
        n.inputPorts.forEach((p) => {
            let constNameCollector = '';
            let constNumCollector: number[] = [];
            const portSigs: Signals = p.value;
            portSigs.forEach((portSig, portSigIndex) => {
                const portSigNum = Number(portSig);
                // is constant?
                if (portSig === '0' || portSig === '1') {
                    maxNum += 1;
                    constNameCollector += portSig;
                    // replace the constant with new signal num
                    portSigs[portSigIndex] = maxNum;
                    constNumCollector.push(maxNum);
                // string of constants ended before end of p.value
                } else if (constNumCollector.length > 0) {
                    assignConstant(constNameCollector,
                                   constNumCollector,
                                   portSigIndex,
                                   signalsByConstantName,
                                   portSigs,
                                   module);
                    // reset name and num collectors
                    constNameCollector = '';
                    constNumCollector = [];
                }
            });
            if (constNumCollector.length > 0) {
                assignConstant(constNameCollector,
                               constNumCollector,
                               portSigs.length,
                               signalsByConstantName,
                               portSigs,
                               module);
            }
        });
    });
}

// solves for minimal bus splits and joins and adds them to module
function addSplitsJoins(module: FlatModule) {
    const allInputs = [];
    const allOutputs = [];
    module.nodes.forEach((n) => {
        n.inputPorts.forEach((i) => {
            allInputs.push(',' + i.value.join() + ',');
        });
        n.outputPorts.forEach((i) => {
            allOutputs.push(',' + i.value.join() + ',');
        });
    });

    const allInputsCopy = allInputs.slice();
    const splits: SplitJoin = {};
    const joins: SplitJoin = {};
    allInputs.forEach((input) => {
        gather(
            allOutputs,
            allInputsCopy,
            input,
            0,
            input.length,
            splits,
            joins);
    });

    for (const target of Object.keys(joins)) {
        // turn string into array of signal names
        const signalStrs: string[] = target.slice(1, -1).split(',');
        const signals: Signals = _.map(signalStrs, (ss) =>  Number(ss) );
        const joinOutPorts: FlatPort[] = [{ key: 'Y', value: signals }];
        const inPorts: FlatPort[] = [];
        joins[target].forEach((name) => {
            const sigs: Signals = getBits(signals, name);
            inPorts.push({ key: name, value: sigs });
        });
        module.nodes.push({
            key: '$join$' + target,
            type: '$_join_',
            inputPorts: inPorts,
            outputPorts: joinOutPorts,
        });
    }

    for (const source of Object.keys(splits)) {
        // turn string into array of signal names
        const signals: Signals = source.slice(1, -1).split(',');
        // convert the signals into actual numbers
        // after running constant pass, all signals should be numbers
        for (const i of Object.keys(signals)) {
            signals[i] = Number(signals[i]);
        }
        const inPorts: FlatPort[] = [{ key: 'A', value: signals }];
        const splitOutPorts: FlatPort[] = [];
        splits[source].forEach((name) => {
            const sigs: Signals = getBits(signals, name);
            splitOutPorts.push({ key: name, value: sigs });
        });
        module.nodes.push({
            key: '$split$' + source,
            type: '$_split_',
            inputPorts: inPorts,
            outputPorts: splitOutPorts,
        });
    }
}

// returns a string that represents the values of the array of integers
// [1, 2, 3] -> ',1,2,3,'
function arrayToBitstring(bitArray: number[]): string {
    let ret: string = '';
    bitArray.forEach((bit: number) => {
        const sbit = String(bit);
        if (ret === '') {
            ret = sbit;
        } else {
            ret += ',' + sbit;
        }
    });
    return ',' + ret + ',';
}

// returns whether needle is a substring of haystack
function arrayContains(needle: string, haystack: string | string[]): boolean {
    return (haystack.indexOf(needle) > -1);
}

// returns the index of the string that contains a substring
// given arrhaystack, an array of strings
function indexOfContains(needle: string, arrhaystack: string[]): number {
    return _.findIndex(arrhaystack, (haystack: string) => {
        return arrayContains(needle, haystack);
    });
}

function getBits(signals: Signals, indicesString: string) {
    const index = indicesString.indexOf(':');
    // is it the whole thing?
    if (index === -1) {
        return [signals[Number(indicesString)]];
    } else {
        const start = indicesString.slice(0, index);
        const end = indicesString.slice(index + 1);
        const slice = signals.slice(Number(start), Number(end) + 1);
        return slice;
    }
}

interface SplitJoin {
    [portName: string]: string[];
}

function addToDefaultDict(dict: any, key: string, value: any) {
    if (dict[key] === undefined) {
        dict[key] = [value];
    } else {
        dict[key].push(value);
    }
}

// string (for labels), that represents an index
// or range of indices.
function getIndicesString(bitstring: string, query: string, start: number): string {
    const splitStart: number = _.max([bitstring.indexOf(query), start]);
    const startIndex: number = bitstring.substring(0, splitStart).split(',').length - 1;
    const endIndex: number = startIndex + query.split(',').length - 3;

    if (startIndex === endIndex) {
        return String(startIndex);
    } else {
        return String(startIndex) + ':' + String(endIndex);
    }
}

// gather splits and joins
function gather(inputs: string[],  // all inputs
                outputs: string[], // all outputs
                toSolve: string, // an input array we are trying to solve
                start: number,   // index of toSolve to start from
                end: number,     // index of toSolve to end at
                splits: SplitJoin,  // container collecting the splits
                joins: SplitJoin) {  // container collecting the joins
    // remove myself from outputs list if present
    const outputIndex: number = outputs.indexOf(toSolve);
    if (outputIndex !== -1) {
        outputs.splice(outputIndex, 1);
    }

    // This toSolve is compconste
    if (start >= toSolve.length || end - start < 2) {
        return;
    }

    const query: string = toSolve.slice(start, end);

    // are there are perfect matches?
    if (arrayContains(query, inputs)) {
        if (query !== toSolve) {
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        gather(inputs, outputs, toSolve, end - 1, toSolve.length, splits, joins);
        return;
    }
    const index: number = indexOfContains(query, inputs);
    // are there any partial matches?
    if (index !== -1) {
        if (query !== toSolve) {
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        // found a split
        addToDefaultDict(splits, inputs[index], getIndicesString(inputs[index], query, 0));
        // we can match to this now
        inputs.push(query);
        gather(inputs, outputs, toSolve, end - 1, toSolve.length, splits, joins);
        return;
    }
    // are there any output matches?
    if (indexOfContains(query, outputs) !== -1) {
        if (query !== toSolve) {
            // add to join
            addToDefaultDict(joins, toSolve, getIndicesString(toSolve, query, start));
        }
        // gather without outputs
        gather(inputs, [], query, 0, query.length, splits, joins);
        inputs.push(query);
        return;
    }
    gather(inputs, outputs, toSolve, start, start + query.slice(0, -1).lastIndexOf(',') + 1, splits, joins);
}

interface NameToPorts {
    [netName: string]: FlatPort[];
}

interface StringToBool {
    [s: string]: boolean;
}

function removeDups(inStrs: string[]) {
    const map: StringToBool = {};
    inStrs.forEach((str) => {
        map[str] = true;
    });
    return _.keys(map);
}

// search through all the ports to find all of the wires
function createWires(module: FlatModule, skin) {
    const layoutProps = getProperties(skin);
    const ridersByNet: NameToPorts = {};
    const driversByNet: NameToPorts = {};
    const lateralsByNet: NameToPorts = {};
    module.nodes.forEach((n) => {
        const template = findSkinType(skin, n.type);
        const lateralPids = getLateralPortPids(template);
        // find all ports connected to the same net
        n.inputPorts.forEach((port) => {
            port.parentNode = n;
            const portSigs: number[] = port.value as number[];
            const isLateral = lateralPids.indexOf(port.key) !== -1;
            if (isLateral || (template[1]['s:type'] === 'generic' && layoutProps.genericsLaterals)) {
                addToDefaultDict(lateralsByNet, arrayToBitstring(portSigs), port);
            } else {
                addToDefaultDict(ridersByNet, arrayToBitstring(portSigs), port);
            }
        });
        n.outputPorts.forEach((port) => {
            port.parentNode = n;
            const portSigs: number[] = port.value as number[];
            const isLateral = lateralPids.indexOf(port.key) !== -1;
            if (isLateral || (template[1]['s:type'] === 'generic' && layoutProps.genericsLaterals)) {
                addToDefaultDict(lateralsByNet, arrayToBitstring(portSigs), port);
            } else {
                addToDefaultDict(driversByNet, arrayToBitstring(portSigs), port);
            }
        });
    });
    // list of unique nets
    const nets = removeDups(_.keys(ridersByNet).concat(_.keys(driversByNet)).concat(_.keys(lateralsByNet)));
    const wires: Wire[] = nets.map((net) => {
        const drivers: FlatPort[] = driversByNet[net] || [];
        const riders: FlatPort[] = ridersByNet[net] || [];
        const laterals: FlatPort[] = lateralsByNet[net] || [];
        const wire: Wire = { drivers, riders, laterals};
        drivers.concat(riders).concat(laterals).forEach((port) => {
            port.wire = wire;
        });
        return wire;
    });
    module.wires = wires;
}
