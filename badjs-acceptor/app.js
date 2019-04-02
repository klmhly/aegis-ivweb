/* global process, global, GLOBAL */
'use strict';
const express = require('express');
const bodyParser = require('body-parser');
const log4js = require('log4js');
const logger = log4js.getLogger();

const http = require('http');
const path = require('path');
const fs = require('fs');

const cluster = require('cluster');

const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: true
}));

const argv = process.argv.slice(2);

const REG_REFERER = /^https?:\/\/[^\/]+\//i;
const REG_DOMAIN = /^(?:https?:)?(?:\/\/)?([^\/]+\.[^\/]+)\/?/i;

const deflateObj = {
    f: 'from',
    l: 'level',
    m: 'msg',
    t: 'time',
    v: 'version'
};

if (argv.indexOf('--debug') >= 0) {
    logger.setLevel('DEBUG');
    global.debug = true;
} else {
    logger.setLevel('INFO');
}

if (argv.indexOf('--project') >= 0) {
    global.pjconfig = require(path.join(__dirname, 'project.debug.json'));
} else {
    global.pjconfig = require(path.join(__dirname, 'project.json'));
}

if (cluster.isMaster) {
    const clusters = [];
    // Fork workers.
    for (let i = 0; i < 4; i++) {
        const forkCluster = cluster.fork();
        clusters.push(forkCluster);
    }

    setTimeout(function () {
        require('./service/ProjectService')(clusters);
    }, 3000);

    return;
}

const interceptor = require('c-interceptor')();
const interceptors = global.pjconfig.interceptors;

interceptors.forEach(function (value, key) {
    var one = require(value)();
    interceptor.add(one);
});
interceptor.add(require(global.pjconfig.dispatcher.module)());

const forbiddenData = '403 forbidden';

global.projectsInfo = {};
global.offlineAutoInfo = {};

const get_domain = function (url) {
    return (url.toString().match(REG_DOMAIN) || ['', ''])[1].replace(/^\*\./, '');
};

var genBlacklistReg = function (data) {
    // ip黑名单正则
    const blacklistIPRegExpList = [];
    (data.blacklist && data.blacklist.ip ? data.blacklist.ip : []).forEach(function (reg) {
        blacklistIPRegExpList.push(new RegExp("^" + reg.replace(/\./g, "\\.")));
    });
    data.blacklistIPRegExpList = blacklistIPRegExpList;

    // ua黑名单正则
    const blacklistUARegExpList = [];
    (data.blacklist && data.blacklist.ua ? data.blacklist.ua : []).forEach(function (reg) {
        blacklistUARegExpList.push(new RegExp(reg, "i"));
    });
    data.blacklistUARegExpList = blacklistUARegExpList;

};

function getClientIp(req) {
    try {
        const xff = (
            req.headers['X-Forwarded-For'] ||
            req.headers['x-forwarded-for'] ||
            ''
        ).split(',')[0].trim();

        return xff ||
            req.connection.remoteAddress ||
            req.socket.remoteAddress ||
            req.connection.socket.remoteAddress;
    } catch (ex) {

    }

    return "0.0.0.0";
}

process.on('message', function (data) {
    const json = data;
    let info;
    if (json.projectsInfo) {
        info = JSON.parse(json.projectsInfo);
        if (typeof info === "object") {
            for (const k in info) {
                const v = info[k] || {};
                v.domain = get_domain(v.url);
                genBlacklistReg(v);
            }
            global.projectsInfo = info;
        }
    }
});

/**
 * 校验来源的url 是否和填写的url相同
 * @param id
 * @param req
 * @returns {boolean}
 */
const referer_match = function (id, req) {
    const referer = (((req || {}).headers || {}).referer || "").toString();

    const projectMatchDomain = (global.projectsInfo[id.toString()] || {}).domain;
    // no referer
    if (!referer) {
        // match match is * , no detect referer
        if (!projectMatchDomain) {
            return true;
        }
        logger.debug('no referer ,  forbidden :' + req.query.id);
        return false;
    }
    const domain = (referer.match(REG_REFERER) || [""])[0] || "";
    return typeof global.projectsInfo === "object" &&
        domain.indexOf(projectMatchDomain) !== -1;
};

const reponseReject = function (res, responseHeader, code = 204) {
    responseHeader['Content-length'] = forbiddenData.length;
    res.writeHead(code, responseHeader);
    res.write(forbiddenData);
    res.end();
};

const responseHeader = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'image/jpeg',
    'Connection': 'close'
};

app.use('/badjs/offlineLog', function (req, res) {

    // 大于 10ms , forbidden
    if (parseInt(req.headers['content-length']) > 10485760) {
        res.end('logs too large');
        return;
    }

    let offline_log = req.body.offline_log;

    if (typeof offline_log === 'string') {
        try {
            offline_log = JSON.parse(offline_log);
        } catch (e) {
            throw new Error(e);
        }
    }

    if (!/^[0-9]{1,5}$/.test(offline_log.id)) {
        throw new Error('invalid id ' + offline_log.id);
    }

    if (!/^[0-9]{5,11}$/.test(offline_log.uin)) {
        throw new Error('invalid uin ' + offline_log.uin);
    }

    const logs = offline_log.logs;
    const msgObj = offline_log.msgObj;
    const urlObj = offline_log.urlObj;

    if (!logs || !logs.length) {
        throw new Error('wrong logs');
    }

    const filePath = path.join(global.pjconfig.offline.path, offline_log.id + "");

    const fileName = offline_log.uin + '_' + offline_log.startDate + '_' + offline_log.endDate;

    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(filePath);
    }

    logs.map(function (log) {
        if (msgObj) {
            log.m = msgObj[log.m];
        }
        if (urlObj) {
            log.f = urlObj[log.f];
        }
        for (const k in deflateObj) {
            if (k in log) {
                const v = deflateObj[k];
                log[v] = log[k];
                delete log[k];
            }
        }
        return log;
    });

    fs.writeFile(path.join(filePath, fileName), JSON.stringify(offline_log), function (err) {
        if (!err) {
            console.log('write offline log success');
        }
    });

    res.end('ok');

})
    .use('/badjs/offlineAuto', function (req, res) {
        const param = req.query;
        http.get(global.pjconfig.offline.offlineLogCheck + "?id=" + param.id + "&uin=" + param.uin, function (clientRes) {
            var result = "";
            clientRes.setEncoding('utf8');
            clientRes.on("data", function (chunk) {
                result += chunk;
            });

            clientRes.on("end", function () {
                res.end("window && window._badjsOfflineAuto && window._badjsOfflineAuto(" + (result ? result : false) + ");");
            });
        }).on('error', function (e) {
            logger.warn("offlineLogCheck err , ", e);
            res.end("window && window._badjsOfflineAuto && window._badjsOfflineAuto(false);");
        });

    })
    .use('/badjs/mpOfflineAuto', function (req, res) {
        const param = req.query;

        http.get(global.pjconfig.offline.offlineLogCheck + "?id=" + param.id + "&uin=" + param.uin, function (clientRes) {
            let result = "";
            clientRes.setEncoding('utf8');
            clientRes.on("data", function (chunk) {
                result += chunk;
            });

            clientRes.on("end", function () {
                return res.end(JSON.stringify({
                    code: 200,
                    msg: result ? result : false
                }));
            });
        }).on('error', function (e) {
            logger.warn("offlineLogCheck err , ", e);
            return res.end(JSON.stringify({
                coo: 500,
                error: e
            }));
        });
    })
    .use('/badjs', function (req, res) {

        let param = req.query;
        if (req.method === "POST" && req.body && !!req.body.id) {
            param = req.body;
        }

        const id = param.id - 0;

        if (isNaN(id)) {
            reponseReject(res, responseHeader, 204);
            return;
        }

        if (id <= 0 || id >= 9999 || !global.projectsInfo[id + ""] || !referer_match(id, req)) {
            reponseReject(res, responseHeader);
            logger.debug('forbidden :' + param.id);
            return;
        }

        param.id = id;

        try {
            interceptor.invoke({
                req: req,
                data: param
            });
        } catch (err) {
            reponseReject(res, responseHeader);
            logger.debug('id ' + param.id + ' , interceptor error :' + err);
            return;
        }

        if (req.throwError) {
            reponseReject(res, responseHeader);
            logger.debug('id ' + param.id + ' , interceptor reject :' + req.throwError);
            return;
        }

        // responseHeader end with 204
        responseHeader['Content-length'] = 0;
        res.writeHead(204, responseHeader);

        logger.debug('===== complete a message =====');
        res.end();


    })
    .listen(global.pjconfig.port);

logger.info('start badjs-accepter , listen ' + global.pjconfig.port + ' ...');
