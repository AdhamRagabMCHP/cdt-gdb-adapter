/*********************************************************************
 * Copyright (c) 2019 Kichwa Coders and others
 *
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *********************************************************************/

import { GDBDebugSession, RequestArguments } from './GDBDebugSession';
import {
    InitializedEvent,
    Logger,
    logger,
    OutputEvent,
} from '@vscode/debugadapter';
import * as mi from './mi';
import { DebugProtocol } from '@vscode/debugprotocol';
import { spawn, ChildProcess } from 'child_process';
import{ SerialPort, ReadlineParser } from "serialport";
import { Socket } from "net";

export interface TargetAttachArguments {
    // Target type default is "remote"
    type?: string;
    // Target parameters would be something like "localhost:12345", defaults
    // to [`${host}:${port}`]
    parameters?: string[];
    // Target host to connect to, defaults to 'localhost', ignored if parameters is set
    host?: string;
    // Target port to connect to, ignored if parameters is set
    port?: string;
    // Target connect commands - if specified used in preference of type, parameters, host, target
    connectCommands?: string[];
    // Settings related to displaying UART output in the debug console
    uart?: {
        // Path to the serial port connected to the UART on the board.
        serialPort?: string;
        // Target TCP port on the host machine to attach socket to print UART output (defaults to 3456)
        socketPort?: string;
        // Baud Rate (in bits/s) of the serial port to be opened (defaults to 115200).
        baudRate?: number;
        // The number of bits in each character of data sent across the serial line (defaults to 8).
        characterSize?: (5 | 6 | 7 | 8);
        // The type of parity check enabled with the transmitted data (defaults to "none" - no parity bit sent)
        parity?: ("none" | "even" | "odd" | "mark" | "space");
        // The number of stop bits sent to allow the receiver to detect the end of characters and resynchronize with the character stream (defaults to 1).
        stopBits?: (1 | 1.5 | 2);
        // The handshaking method used for flow control across the serial line (defaults to "none" - no handshaking)
        handshakingMethod?: ("none" | "XON/XOFF" | "RTS/CTS");
    }
}

export interface TargetLaunchArguments extends TargetAttachArguments {
    // The executable for the target server to launch (e.g. gdbserver or JLinkGDBServerCLExe),
    // defaults to 'gdbserver --once :0 ${args.program}' (requires gdbserver >= 7.3)
    server?: string;
    serverParameters?: string[];
    // Regular expression to extract port from by examinging stdout/err of server.
    // Once server is launched, port will be set to this if port is not set.
    // defaults to matching a string like 'Listening on port 41551' which is what gdbserver provides
    // Ignored if port or parameters is set
    serverPortRegExp?: string;
    // Delay after startup before continuing launch, in milliseconds. If serverPortRegExp is
    // provided, it is the delay after that regexp is seen.
    serverStartupDelay?: number;
    // Automatically kill the launched server when client issues a disconnect (default: true)
    automaticallyKillServer?: boolean;
    // Specifies the working directory of gdbserver
    cwd?: string;
}

export interface ImageAndSymbolArguments {
    // If specified, a symbol file to load at the given (optional) offset
    symbolFileName?: string;
    symbolOffset?: string;
    // If specified, an image file to load at the given (optional) offset
    imageFileName?: string;
    imageOffset?: string;
}

export interface TargetAttachRequestArguments extends RequestArguments {
    target?: TargetAttachArguments;
    imageAndSymbols?: ImageAndSymbolArguments;
    // Optional commands to issue between loading image and resuming target
    preRunCommands?: string[];
}

export interface TargetLaunchRequestArguments
    extends TargetAttachRequestArguments {
    target?: TargetLaunchArguments;
    imageAndSymbols?: ImageAndSymbolArguments;
    // Optional commands to issue between loading image and resuming target
    preRunCommands?: string[];
}

export class GDBTargetDebugSession extends GDBDebugSession {
    protected gdbserver?: ChildProcess;
    protected killGdbServer = true;

    // Serial Port to capture UART output across the serial line
    protected serialPort?: SerialPort;
    // Socket to listen on a TCP port to capture UART output
    protected socket?: Socket;

    protected async attachOrLaunchRequest(
        response: DebugProtocol.Response,
        request: 'launch' | 'attach',
        args: TargetLaunchRequestArguments | TargetAttachRequestArguments
    ) {
        this.setupCommonLoggerAndHandlers(args);

        if (request === 'launch') {
            const launchArgs = args as TargetLaunchRequestArguments;
            if (
                launchArgs.target?.serverParameters === undefined &&
                !launchArgs.program
            ) {
                this.sendErrorResponse(
                    response,
                    1,
                    'The program must be specified in the launch request arguments'
                );
                return;
            }
            await this.startGDBServer(launchArgs);
        }

        await this.startGDBAndAttachToTarget(response, args);
    }

    protected async launchRequest(
        response: DebugProtocol.LaunchResponse,
        args: TargetLaunchRequestArguments
    ): Promise<void> {
        try {
            const [request, resolvedArgs] = this.applyRequestArguments(
                'launch',
                args
            );
            await this.attachOrLaunchRequest(response, request, resolvedArgs);
        } catch (err) {
            this.sendErrorResponse(
                response,
                1,
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    protected async attachRequest(
        response: DebugProtocol.AttachResponse,
        args: TargetAttachRequestArguments
    ): Promise<void> {
        try {
            const [request, resolvedArgs] = this.applyRequestArguments(
                'attach',
                args
            );
            await this.attachOrLaunchRequest(response, request, resolvedArgs);
        } catch (err) {
            this.sendErrorResponse(
                response,
                1,
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    protected setupCommonLoggerAndHandlers(args: TargetLaunchRequestArguments) {
        logger.setup(
            args.verbose ? Logger.LogLevel.Verbose : Logger.LogLevel.Warn,
            args.logFile || false
        );

        this.gdb.on('consoleStreamOutput', (output, category) => {
            this.sendEvent(new OutputEvent(output, category));
        });

        this.gdb.on('execAsync', (resultClass, resultData) =>
            this.handleGDBAsync(resultClass, resultData)
        );
        this.gdb.on('notifyAsync', (resultClass, resultData) =>
            this.handleGDBNotify(resultClass, resultData)
        );
    }

    protected async startGDBServer(
        args: TargetLaunchRequestArguments
    ): Promise<void> {
        if (args.target === undefined) {
            args.target = {};
        }
        const target = args.target;
        const serverExe =
            target.server !== undefined ? target.server : 'gdbserver';
        const serverCwd = target.cwd !== undefined ? target.cwd : args.cwd;
        const serverParams =
            target.serverParameters !== undefined
                ? target.serverParameters
                : ['--once', ':0', args.program];

        this.killGdbServer = target.automaticallyKillServer !== false;

        // Wait until gdbserver is started and ready to receive connections.
        await new Promise<void>((resolve, reject) => {
            this.gdbserver = spawn(serverExe, serverParams, { cwd: serverCwd });
            let gdbserverStartupResolved = false;
            let accumulatedStderr = '';
            let checkTargetPort = (_data: any) => {
                // do nothing by default
            };
            if (target.port && target.serverParameters) {
                setTimeout(
                    () => {
                        gdbserverStartupResolved = true;
                        resolve();
                    },
                    target.serverStartupDelay !== undefined
                        ? target.serverStartupDelay
                        : 0
                );
            } else {
                checkTargetPort = (data: any) => {
                    const regex = new RegExp(
                        target.serverPortRegExp
                            ? target.serverPortRegExp
                            : 'Listening on port ([0-9]+)'
                    );
                    const m = regex.exec(data);
                    if (m !== null) {
                        target.port = m[1];
                        setTimeout(
                            () => {
                                gdbserverStartupResolved = true;
                                resolve();
                            },
                            target.serverStartupDelay !== undefined
                                ? target.serverStartupDelay
                                : 0
                        );
                    }
                };
            }
            if (this.gdbserver.stdout) {
                this.gdbserver.stdout.on('data', (data) => {
                    this.sendEvent(new OutputEvent(data.toString(), 'server'));
                    checkTargetPort(data);
                });
            } else {
                throw new Error('Missing stdout in spawned gdbserver');
            }

            if (this.gdbserver.stderr) {
                this.gdbserver.stderr.on('data', (data) => {
                    const err = data.toString();
                    accumulatedStderr += err;
                    this.sendEvent(new OutputEvent(err, 'server'));
                    checkTargetPort(data);
                });
            } else {
                throw new Error('Missing stderr in spawned gdbserver');
            }

            this.gdbserver.on('exit', (code, signal) => {
                let exitmsg: string;
                if (code === null) {
                    exitmsg = `${serverExe} is killed by signal ${signal}`;
                } else {
                    exitmsg = `${serverExe} has exited with code ${code}`;
                }
                this.sendEvent(new OutputEvent(exitmsg, 'server'));
                if (!gdbserverStartupResolved) {
                    gdbserverStartupResolved = true;
                    reject(new Error(exitmsg + '\n' + accumulatedStderr));
                }
            });

            this.gdbserver.on('error', (err) => {
                const errmsg = `${serverExe} has hit error ${err}`;
                this.sendEvent(new OutputEvent(errmsg, 'server'));
                if (!gdbserverStartupResolved) {
                    gdbserverStartupResolved = true;
                    reject(new Error(errmsg + '\n' + accumulatedStderr));
                }
            });
        });
    }

    protected async startGDBAndAttachToTarget(
        response: DebugProtocol.AttachResponse | DebugProtocol.LaunchResponse,
        args: TargetAttachRequestArguments
    ): Promise<void> {
        if (args.target === undefined) {
            args.target = {};
        }
        const target = args.target;
        try {
            this.isAttach = true;
            await this.spawn(args);
            await this.gdb.sendFileExecAndSymbols(args.program);
            await this.gdb.sendEnablePrettyPrint();
            if (args.imageAndSymbols) {
                if (args.imageAndSymbols.symbolFileName) {
                    if (args.imageAndSymbols.symbolOffset) {
                        await this.gdb.sendAddSymbolFile(
                            args.imageAndSymbols.symbolFileName,
                            args.imageAndSymbols.symbolOffset
                        );
                    } else {
                        await this.gdb.sendFileSymbolFile(
                            args.imageAndSymbols.symbolFileName
                        );
                    }
                }
            }

            if (target.connectCommands === undefined) {
                const targetType =
                    target.type !== undefined ? target.type : 'remote';
                let defaultTarget: string[];
                if (target.port !== undefined) {
                    defaultTarget = [
                        target.host !== undefined
                            ? `${target.host}:${target.port}`
                            : `localhost:${target.port}`,
                    ];
                } else {
                    defaultTarget = [];
                }
                const targetParameters =
                    target.parameters !== undefined
                        ? target.parameters
                        : defaultTarget;
                await mi.sendTargetSelectRequest(this.gdb, {
                    type: targetType,
                    parameters: targetParameters,
                });
                this.sendEvent(
                    new OutputEvent(
                        `connected to ${targetType} target ${targetParameters.join(
                            ' '
                        )}`
                    )
                );
            } else {
                await this.gdb.sendCommands(target.connectCommands);
                this.sendEvent(
                    new OutputEvent(
                        'connected to target using provided connectCommands'
                    )
                );
            }

            await this.gdb.sendCommands(args.initCommands);

            if (target.uart !== undefined) {
                if (target.uart.serialPort !== undefined) {
                    try {
                        // Set the path to the serial port
                        this.serialPort = new SerialPort({
                            path: target.uart.serialPort,
                            // If the serial port path is defined, then so will the baud rate.
                            baudRate: target.uart.baudRate ?? 115200,
                            // If the serial port path is deifned, then so will the number of data bits.
                            dataBits: target.uart.characterSize ?? 8,
                            // If the serial port path is defined, then so will the number of stop bits.
                            stopBits: target.uart.stopBits ?? 1,
                            // If the serial port path is defined, then so will the parity check type.
                            parity: target.uart.parity ?? 'none',
                            // If the serial port path is defined, then so will the type of handshaking method.
                            rtscts:
                                target.uart.handshakingMethod === 'RTS/CTS'
                                    ? true
                                    : false,
                            xon:
                                target.uart.handshakingMethod === 'XON/XOFF'
                                    ? true
                                    : false,
                            xoff:
                                target.uart.handshakingMethod === 'XON/XOFF'
                                    ? true
                                    : false,
                            autoOpen: false,
                        });

                        this.serialPort.on("open", () => {
                            this.sendEvent(
                                new OutputEvent(
                                    `listening on serial port ${this.serialPort?.path}`,
                                    "Serial Port"
                                )
                            );
                        });

                        const SerialUartParser = new ReadlineParser({
                            delimiter: "\n",
                            encoding: "utf8"
                        });

                        this.serialPort.pipe(SerialUartParser).on("data", (line: string) => {
                            this.sendEvent(
                                new OutputEvent(line, "Serial Port")
                            );
                        });

                        this.serialPort.on("close", () => {
                            this.sendEvent(
                                new OutputEvent(
                                    "closing serial port connection",
                                    "Serial Port"
                                )
                            );
                        });

                        this.serialPort.open();
                    } catch (err) {
                        this.sendErrorResponse(
                            response,
                            1,
                            err instanceof Error ? err.message : String(err)
                        );
                    }
                } else if (target.uart.socketPort !== undefined) {
                    try {
                        /**
                         * This is a placeholder for the socket. We assign the correct socket
                         * port path below in "startGDBAndAttachToTarget" if it is specified.
                         */
                        this.socket = new Socket();
                        this.socket.setEncoding("utf-8");

                        let tcpUartData = "";
                        this.socket.on("data", (data: string) => {
                            for (const char of data) {
                                if (char === "\n") {
                                    this.sendEvent(
                                        new OutputEvent(
                                            tcpUartData,
                                            "Socket"
                                        )
                                    )
                                    tcpUartData = "";
                                } else{
                                    tcpUartData += char;
                                }
                            }
                        });
                        this.socket.on("close", () => {
                            this.sendEvent(
                                new OutputEvent(
                                    tcpUartData,
                                    "Socket"
                                )
                            );
                            this.sendEvent(
                                new OutputEvent(
                                    "closing socket connection",
                                    "Socket"
                                )
                            );
                        });

                        this.socket.connect(
                            // Putting a + (unary plus operator) infront of the string converts it to a number.
                            +target.uart.socketPort,
                            // Default to localhost if target.host is undefined.
                            target.host ?? "localhost",
                            () => {
                                this.sendEvent(
                                    new OutputEvent(
                                        `listening on tcp port ${target.uart?.socketPort}`,
                                        "Socket"
                                    )
                                );
                            }
                        );
                    } catch (err) {
                        this.sendErrorResponse(
                            response,
                            1,
                            err instanceof Error ? err.message : String(err)
                        );
                    }
                }
            }

            if (args.imageAndSymbols) {
                if (args.imageAndSymbols.imageFileName) {
                    await this.gdb.sendLoad(
                        args.imageAndSymbols.imageFileName,
                        args.imageAndSymbols.imageOffset
                    );
                }
            }
            await this.gdb.sendCommands(args.preRunCommands);
            this.sendEvent(new InitializedEvent());
            this.sendResponse(response);
            this.isInitialized = true;
            this.sendEvent(
                new OutputEvent(
                    "starting debug"
                )
            );
        } catch (err) {
            this.sendErrorResponse(
                response,
                1,
                err instanceof Error ? err.message : String(err)
            );
        }
    }

    protected async stopGDBServer(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.gdbserver || this.gdbserver.exitCode !== null) {
                resolve();
            } else {
                this.gdbserver.on('exit', () => {
                    resolve();
                });
                this.gdbserver?.kill();
            }
            setTimeout(() => {
                reject();
            }, 1000);
        });
    }

    protected async disconnectRequest(
        response: DebugProtocol.DisconnectResponse,
        _args: DebugProtocol.DisconnectArguments
    ): Promise<void> {
        try {
            try {
                if (
                    this.serialPort !== undefined &&
                    this.serialPort.isOpen
                )
                    this.serialPort.close();
            } catch (err) {
                this.sendErrorResponse(
                    response,
                    1,
                    err instanceof Error ? err.message : String(err)
                );
            }
            await this.gdb.sendGDBExit();
            if (this.killGdbServer) {
                await this.stopGDBServer();
                this.sendEvent(new OutputEvent('gdbserver stopped', 'server'));
            }
            this.sendResponse(response);
        } catch (err) {
            this.sendErrorResponse(
                response,
                1,
                err instanceof Error ? err.message : String(err)
            );
        }
    }
}
