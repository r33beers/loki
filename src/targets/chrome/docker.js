const debug = require('debug')('loki:chrome:docker');
const os = require('os');
const { execSync } = require('child_process');
const execa = require('execa');
const waitOn = require('wait-on');
const CDP = require('chrome-remote-interface');
const fs = require('fs-extra');
const getRandomPort = require('get-port');
const { ensureDependencyAvailable } = require('../../dependency-detection');
const { ChromeError } = require('../../errors');
const createChromeTarget = require('./create-chrome-target');

const getExecutor = dockerWithSudo => (dockerPath, args) => {
  if (dockerWithSudo) {
    return execa('sudo', [dockerPath, ...args]);
  }

  return execa(dockerPath, args);
};

const getLocalIPAddress = () => {
  const interfaces = os.networkInterfaces();
  const ips = Object.keys(interfaces)
    .map(key =>
      interfaces[key]
        .filter(({ family, internal }) => family === 'IPv4' && !internal)
        .map(({ address }) => address)
    )
    .reduce((acc, current) => acc.concat(current), []);
  return ips[0];
};

const waitOnCDPAvailable = (host, port) =>
  new Promise((resolve, reject) => {
    waitOn(
      {
        resources: [`tcp:${host}:${port}`],
        delay: 50,
        interval: 100,
        timeout: 5000,
      },
      err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });

const getNetworkHost = async (execute, dockerId) => {
  let host = '127.0.0.1';

  // https://tuhrig.de/how-to-know-you-are-inside-a-docker-container/
  const runningInsideDocker =
    fs.existsSync('/proc/1/cgroup') &&
    /docker/.test(fs.readFileSync('/proc/1/cgroup', 'utf8'));

  // If we are running inside a docker container, our spawned docker chrome instance will be a sibling on the default
  // bridge, which means we can talk directly to it via its IP address.
  if (runningInsideDocker) {
    const { code, stdout } = await execute('docker', [
      'inspect',
      '-f',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      dockerId,
    ]);

    if (code !== 0) {
      throw new Error('Unable to determine IP of docker container');
    }

    host = stdout;
  }

  return host;
};

function createChromeDockerTarget({
  baseUrl = 'http://localhost:6006',
  chromeDockerImage = 'yukinying/chrome-headless',
  chromeFlags = ['--headless', '--disable-gpu', '--hide-scrollbars'],
  dockerWithSudo = false,
  chromeDockerWithoutSeccomp = false,
}) {
  let port;
  let dockerId;
  let host;
  let dockerUrl = baseUrl;
  const dockerPath = 'docker';
  const runArgs = ['run', '--rm', '-d', '-P'];
  const execute = getExecutor(dockerWithSudo);

  if (!chromeDockerWithoutSeccomp) {
    runArgs.push(`--security-opt=seccomp=${__dirname}/docker-seccomp.json`);
  }

  if (baseUrl.indexOf('http://localhost') === 0) {
    const ip = getLocalIPAddress();
    if (!ip) {
      throw new Error(
        'Unable to detect local IP address, try passing --host argument'
      );
    }
    dockerUrl = baseUrl.replace('localhost', ip);
  } else if (baseUrl.indexOf('file:') === 0) {
    const staticPath = baseUrl.substr('file:'.length);
    const staticMountPath = '/var/loki';
    runArgs.push('-v');
    runArgs.push(`${staticPath}:${staticMountPath}`);
    dockerUrl = `file://${staticMountPath}`;
  }

  async function getIsImageDownloaded(imageName) {
    const { code, stdout, stderr } = await execute(dockerPath, [
      'images',
      '-q',
      imageName,
    ]);
    if (code !== 0) {
      throw new Error(`Failed querying docker, ${stderr}`);
    }
    return stdout.trim().length !== 0;
  }

  async function ensureImageDownloaded() {
    ensureDependencyAvailable('docker');

    const isImageDownloaded = await getIsImageDownloaded(chromeDockerImage);
    if (!isImageDownloaded) {
      await execute(dockerPath, ['pull', chromeDockerImage]);
    }
  }

  async function start() {
    port = await getRandomPort();

    ensureDependencyAvailable('docker');
    const args = runArgs
      .concat([
        '--shm-size=1g',
        '-p',
        `${port}:${port}`,
        chromeDockerImage,
        '--disable-datasaver-prompt',
        '--no-first-run',
        '--disable-extensions',
        '--remote-debugging-address=0.0.0.0',
        `--remote-debugging-port=${port}`,
      ])
      .concat(chromeFlags);

    debug(
      `Launching chrome in docker with command "${dockerPath} ${args.join(
        ' '
      )}"`
    );
    const { code, stdout, stderr } = await execute(dockerPath, args);
    if (code === 0) {
      dockerId = stdout;
      const logs = execute(dockerPath, ['logs', dockerId, '--follow']);
      let errorLogs = [];
      logs.stderr.on('data', chunk => {
        errorLogs.push(chunk);
      });

      host = await getNetworkHost(dockerId);
      try {
        await waitOnCDPAvailable(host, port);
      } catch (error) {
        if (error.message === 'Timeout' && errorLogs.length !== 0) {
          throw new ChromeError(
            `Chrome failed to start with ${
              errorLogs.length === 1 ? 'error' : 'errors'
            } ${errorLogs
              .map(e => `"${e.toString('utf8').trim()}"`)
              .join(', ')}`
          );
        }
        throw error;
      } finally {
        if (logs.exitCode === null && !logs.killed) {
          logs.kill();
        }
        errorLogs = null;
      }
      debug(`Docker started with id ${dockerId}`);
    } else {
      throw new Error(`Failed starting docker, ${stderr}`);
    }
  }

  async function stop() {
    if (dockerId) {
      debug(`Killing chrome docker instance with id ${dockerId}`);
      await execute(dockerPath, ['kill', dockerId]);
    } else {
      debug('No chrome docker instance to kill');
    }
  }

  async function createNewDebuggerInstance() {
    debug(`Launching new tab with debugger at port ${host}:${port}`);
    const target = await CDP.New({ host, port });
    debug(`Launched with target id ${target.id}`);
    const client = await CDP({ host, port, target });

    client.close = () => {
      debug('New closing tab');
      return CDP.Close({ host, port, id: target.id });
    };

    return client;
  }

  process.on('SIGINT', () => {
    if (dockerId) {
      const maybeSudo = dockerWithSudo ? 'sudo ' : '';
      execSync(`${maybeSudo}${dockerPath} kill ${dockerId}`);
    }
  });

  return createChromeTarget(
    start,
    stop,
    createNewDebuggerInstance,
    dockerUrl,
    ensureImageDownloaded
  );
}

module.exports = createChromeDockerTarget;
