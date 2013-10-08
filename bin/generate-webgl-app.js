#!/usr/bin/env node
/**
 * Copyright 2013 Google, Inc. All Rights Reserved.
 *
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @fileoverview Generate a standalone native WebGL app.
 * Given an input trace file (with recorded WebGL calls) this app will build a
 * standalone native executable that issues those calls directly to OpenGL.
 *
 * @author benvanik@google.com (Ben Vanik)
 */

var child_process = require('child_process');
var fs = require('fs');
var optimist = require('optimist');
var os = require('os');
var path = require('path');

var toolRunner = require('./tool-runner');
var util = toolRunner.util;
toolRunner.launch(runTool);


function runTool(platform, args, done) {
  var argv = optimist
    .usage('Generate a standalone native WebGL app.\nUsage: $0 source.wtf-trace [output.exe]')
    .options('debug', {
      type: 'boolean',
      default: false,
      desc: 'Debug mode.'
    })
    .check(function(argv) {
      if (argv['help']) {
        throw '';
      }
      // Assert has a file.
      if (!argv._.length) {
        throw 'Pass a trace file to process.'
      }
      return true;
    })
    .argv;

  if (argv['debug']) {
    goog.require('wtf.replay.graphics.Step');
  }

  var inputFile = path.resolve(argv._[0]);
  var outputBaseFile = argv._[1] ||
      path.join(path.dirname(inputFile),
                path.basename(inputFile, '.wtf-trace'));

  console.log('Processing ' + inputFile + '...');
  console.log('');

  wtf.db.load(inputFile, function(db) {
    if (db instanceof Error) {
      console.log('ERROR: unable to open ' + inputFile, db, db.stack);
      done(1);
    } else {
      processDatabase(argv, outputBaseFile, db, done);
    }
  });
};


/**
 * Processes a loaded database.
 * @param {!Object} argv Parsed optimist arguments.
 * @param {string} outputBaseFile Base filename for output (without extension).
 * @param {!wtf.db.Database} db Database.
 * @param {function(number)} done Done callback. 0 for success.
 */
function processDatabase(argv, outputBaseFile, db, done) {
  var modulePath = path.dirname(module.filename);
  var templatePath = path.join(modulePath, 'cpp_src');
  var templates = {
    header: fs.readFileSync(path.join(templatePath, 'webgl-header.cc'), 'utf8'),
    footer: fs.readFileSync(path.join(templatePath, 'webgl-footer.cc'), 'utf8')
  };

  var zones = db.getZones();
  if (!zones.length) {
    console.log('No zones');
    done(1);
    return;
  }

  // TODO(benvanik): find the right zone.
  var zone = zones[0];

  // Build a step list.
  var eventList = zone.getEventList();
  var frameList = zone.getFrameList();
  var steps = wtf.replay.graphics.Step.constructStepsList(eventList, frameList);

  var output = [];

  // Add header.
  output.push(templates.header);

  // Add all steps.
  for (var n = 0; n < steps.length; n++) {
    var step = steps[n];
    output.push('void step_' + n + '(Replay* replay) {');
    addStep(eventList, n, step, output);
    output.push('}');
  }

  // Add step list variable.
  var stepFnList = [];
  for (var n = 0; n < steps.length; n++) {
    stepFnList.push('step_' + n + ',');
  }
  output.push(
      'static const StepFunction steps[] = { ' + stepFnList.join(' ') + ' };');

  // Static info.
  output.push(
      'static const char* trace_name = "' +
          path.basename(outputBaseFile) + '";');

  // Add footer.
  output.push(templates.footer);

  // Write output cc file.
  var finalOutput = output.join(os.EOL);
  fs.writeFileSync(outputBaseFile + '.cc', finalOutput);

  // Build!
  build(outputBaseFile, done);
};


/**
 * Builds a native app.
 * @param {string} outputBaseFile Base filename for output (without extension).
 * @param {function(number)} done Done callback. 0 for success.
 */
function build(outputBaseFile, done) {
  switch (os.platform()) {
    case 'linux':
      buildWithGcc();
      break;
    default:
      console.log('Unsupported build platform: ' + os.platform());
      return 1;
  }

  function buildWithGcc() {
    var sourceFiles = [
      outputBaseFile + '.cc'
    ];
    var outputFile = outputBaseFile;

    // Build base command line for G++.
    var commandLine = [
      'g++',
      '-o ' + outputFile,
      sourceFiles.join(' '),
      '-std=c++0x',
      '-L/usr/local/lib',
      '-Wl,-rpath,/usr/local/lib',
      '-lm -lSDL2 -lpthread -lGL -ldl -lrt',
      '-I/usr/local/include/SDL2',
      '-D_REENTRANT'
    ];

    // Build!
    child_process.exec(
        commandLine.join(' '), {
        }, function(error, stdout, stderr) {
          console.log(stdout);
          console.log(stderr);
          if (error !== null) {
            console.log(error);
            done(1);
          } else {
            done(0);
          }
        });
  };
};


function addStep(eventList, stepIndex, step, output) {
  // Locals used by generators.
  output.push('GLubyte scratch_data[2048];');
  output.push('GLuint id;');

  // Local context to make it easy to reference.
  // Kept up to date as setContext is hit.
  var initialContextHandle = step.getInitialCurrentContext();
  if (initialContextHandle != -1) {
    output.push(
        'CanvasContext* context = replay->MakeContextCurrent(' +
            initialContextHandle + ');');
  } else {
    output.push('CanvasContext* context = 0;');
  }

  // Walk events.
  for (var it = step.getEventIterator(true); !it.done(); it.next()) {
    var handler = CALLS[it.getName()];
    if (handler) {
      var args = it.getArguments();
      handler(it, args, output);
      output.push('CHECK_GL();');
    } else {
      var eventString = it.getLongString().replace(/\n/g, ' ');
      // console.log('Unhandled event: ' + eventString);
      output.push('// UNHANDLED EVENT: ' + eventString);
    }
  }
};


function arrayToString(v) {
  var values = Array.prototype.join.call(v, ', ');
  if (v instanceof Int8Array) {
    return '(const GLbyte[]){' + values + '}';
  } else if (v instanceof Uint8Array) {
    return '(const GLubyte[]){' + values + '}';
  } else if (v instanceof Int16Array) {
    return '(const GLshort[]){' + values + '}';
  } else if (v instanceof Uint16Array) {
    return '(const GLushort[]){' + values + '}';
  } else if (v instanceof Int32Array) {
    return '(const GLint[]){' + values + '}';
  } else if (v instanceof Uint32Array) {
    return '(const GLuint[]){' + values + '}';
  } else if (v instanceof Float32Array) {
    return '(const GLfloat[]){' + values + '}';
  } else {
    return 'UNKNOWN_TYPE_IN_ARRAY_TO_STRING';
  }
};


/**
 * A mapping from event names to functions.
 * @type {!Object.<Function>}
 * @private
 */
var CALLS = {
  'WebGLRenderingContext#attachShader': function(
      it, args, output) {
    output.push('glAttachShader(' + [
      'context->GetObject(' + args['program'] + ')',
      'context->GetObject(' + args['shader'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#activeTexture': function(
      it, args, output) {
    output.push('glActiveTexture(' + [
      args['texture']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bindAttribLocation': function(
      it, args, output) {
    output.push('glBindAttribLocation(' + [
      'context->GetObject(' + args['program'] + ')',
      args['index'],
      '"' + args['name'] + '"'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bindBuffer': function(
      it, args, output) {
    output.push('glBindBuffer(' + [
      args['target'],
      'context->GetObject(' + args['buffer'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bindFramebuffer': function(
      it, args, output) {
    output.push('glBindFramebuffer(' + [
      args['target'],
      'context->GetObject(' + args['framebuffer'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bindRenderbuffer': function(
      it, args, output) {
    output.push('glBindRenderbuffer(' + [
      args['target'],
      'context->GetObject(' + args['renderbuffer'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bindTexture': function(
      it, args, output) {
    output.push('glBindTexture(' + [
      args['target'],
      'context->GetObject(' + args['texture'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#blendColor': function(
      it, args, output) {
    output.push('glBlendColor(' + [
      args['red'], args['green'], args['blue'], args['alpha']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#blendEquation': function(
      it, args, output) {
    output.push('glBlendEquation(' + [
      args['mode']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#blendEquationSeparate': function(
      it, args, output) {
    output.push('glBlendEquationSeparate(' + [
      args['modeRGB'], args['modeAlpha']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#blendFunc': function(
      it, args, output) {
    output.push('glBlendFunc(' + [
      args['sfactor'], args['dfactor']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#blendFuncSeparate': function(
      it, args, output) {
    output.push('glBlendFuncSeparate(' + [
      args['srcRGB'], args['dstRGB'], args['srcAlpha'], args['dstAlpha']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bufferData': function(
      it, args, output) {
    var data = args['data'];
    var empty = false;
    if (!data || data.byteLength != args['size']) {
      // Creating as empty.
      empty = true;
    }
    output.push('glBufferData(' + [
      args['target'],
      args['size'],
      empty ? '0' : arrayToString(data),
      args['usage']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#bufferSubData': function(
      it, args, output) {
    var data = args['data'];
    output.push('glBufferSubData(' + [
      args['target'],
      args['offset'],
      data.byteLength,
      arrayToString(data)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#checkFramebufferStatus': function(
      it, args, output) {
    output.push('glCheckFramebufferStatus(' + [
      args['target']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#clear': function(
      it, args, output) {
    output.push('glClear(' + [
      args['mask']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#clearColor': function(
      it, args, output) {
    output.push('glClearColor(' + [
      args['red'], args['green'], args['blue'], args['alpha']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#clearDepth': function(
      it, args, output) {
    output.push('glClearDepth(' + [
      args['depth']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#clearStencil': function(
      it, args, output) {
    output.push('glClearStencil(' + [
      args['s']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#colorMask': function(
      it, args, output) {
    output.push('glColorMask(' + [
      args['red'], args['green'], args['blue'], args['alpha']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#compileShader': function(
      it, args, output) {
    output.push('glCompileShader(' + [
      'context->GetObject(' + args['shader'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#compressedTexImage2D': function(
      it, args, output) {
    output.push('glCompressedTexImage2D(' + [
      args['target'], args['level'], args['internalformat'],
      args['width'], args['height'], args['border'],
      args['data'].byteLength,
      '(const GLvoid*)' + arrayToString(args['data'])
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#compressedTexSubImage2D': function(
      it, args, output) {
    output.push('glCompressedTexSubImage2D(' + [
      args['target'], args['level'], args['xoffset'],
      args['yoffset'], args['width'], args['height'],
      args['format'],
      args['data'].byteLength,
      '(const GLvoid*)' + arrayToString(args['data'])
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#copyTexImage2D': function(
      it, args, output) {
    output.push('glCopyTexImage2D(' + [
      args['target'], args['level'], args['internalformat'],
      args['x'], args['y'], args['width'],
      args['height'], args['border']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#copyTexSubImage2D': function(
      it, args, output) {
    output.push('glCopyTexSubImage2D(' + [
      args['target'], args['level'], args['xoffset'],
      args['yoffset'], args['x'], args['y'],
      args['width'], args['height']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#createBuffer': function(
      it, args, output) {
    output.push('glGenBuffers(1, &id);');
    output.push('context->SetObject(' + args['buffer'] + ', id);');
  },
  'WebGLRenderingContext#createFramebuffer': function(
      it, args, output) {
    output.push('glGenFramebuffers(1, &id);');
    output.push('context->SetObject(' + args['framebuffer'] + ', id);');
  },
  'WebGLRenderingContext#createRenderbuffer': function(
      it, args, output) {
    output.push('glGenRenderbuffers(1, &id);');
    output.push('context->SetObject(' + args['renderbuffer'] + ', id);');
  },
  'WebGLRenderingContext#createTexture': function(
      it, args, output) {
    output.push('glGenTextures(1, &id);');
    output.push('context->SetObject(' + args['texture'] + ', id);');
  },
  'WebGLRenderingContext#createProgram': function(
      it, args, output) {
    output.push('id = glCreateProgram();');
    output.push('context->SetObject(' + args['program'] + ', id);');
  },
  'WebGLRenderingContext#createShader': function(
      it, args, output) {
    output.push('id = glCreateShader(' + args['type'] + ');');
    output.push('context->SetObject(' + args['shader'] + ', id);');
  },
  'WebGLRenderingContext#cullFace': function(
      it, args, output) {
    output.push('glCullFace(' + [
      args['mode']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#deleteBuffer': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['buffer'] + ');');
    output.push('glDeleteBuffers(1, &id);');
  },
  'WebGLRenderingContext#deleteFramebuffer': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['framebuffer'] + ');');
    output.push('glDeleteFramebuffers(1, &id);');
  },
  'WebGLRenderingContext#deleteProgram': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['program'] + ');');
    output.push('glDeleteProgram(id);');
  },
  'WebGLRenderingContext#deleteRenderbuffer': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['renderbuffer'] + ');');
    output.push('glDeleteRenderbuffer(1, &id);');
  },
  'WebGLRenderingContext#deleteShader': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['shader'] + ');');
    output.push('glDeleteShader(id);');
  },
  'WebGLRenderingContext#deleteTexture': function(
      it, args, output) {
    output.push('id = context->GetObject(' + args['texture'] + ');');
    output.push('glDeleteTextures(1, &id);');
  },
  'WebGLRenderingContext#depthFunc': function(
      it, args, output) {
    output.push('glDepthFunc(' + [
      args['func']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#depthMask': function(
      it, args, output) {
    output.push('glDepthMask(' + [
      args['flag']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#depthRange': function(
      it, args, output) {
    output.push('glDepthRange(' + [
      args['zNear'], args['zFar']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#detachShader': function(
      it, args, output) {
    output.push('glDetachShader(' + [
      'context->GetObject(' + args['program'] + ')',
      'context->GetObject(' + args['shader'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#disable': function(
      it, args, output) {
    output.push('glDisable(' + [
      args['cap']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#disableVertexAttribArray': function(
      it, args, output) {
    output.push('glDisableVertexAttribArray(' + [
      args['index']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#drawArrays': function(
      it, args, output) {
    output.push('glDrawArrays(' + [
      args['mode'],
      args['first'],
      args['count']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#drawElements': function(
      it, args, output) {
    output.push('glDrawElements(' + [
      args['mode'],
      args['count'],
      args['type'],
      '(const GLvoid*)' + args['offset']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#enable': function(
      it, args, output) {
    output.push('glEnable(' + args['cap'] + ');');
  },
  'WebGLRenderingContext#enableVertexAttribArray': function(
      it, args, output) {
    output.push('glEnableVertexAttribArray(' + args['index'] + ');');
  },
  'WebGLRenderingContext#finish': function(
      it, args, output) {
    output.push('glFinish();');
  },
  'WebGLRenderingContext#flush': function(
      it, args, output) {
    output.push('glFlush();');
  },
  'WebGLRenderingContext#framebufferRenderbuffer': function(
      it, args, output) {
    output.push('glFramebufferRenderbuffer(' + [
      args['target'],
      args['attachment'],
      args['renderbuffertarget'],
      'context->GetObject(' + args['renderbuffer'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#framebufferTexture2D': function(
      it, args, output) {
    output.push('glFramebufferTexture2D(' + [
      args['target'],
      args['attachment'],
      args['textarget'],
      'context->GetObject(' + args['texture'] + ')',
      args['level']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#frontFace': function(
      it, args, output) {
    output.push('glFrontFace(' + [
      args['mode']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#generateMipmap': function(
      it, args, output) {
    output.push('glGenerateMipmap(' + [
      args['target']
    ].join(', ') + ');');
  },
  // 'WebGLRenderingContext#getActiveAttrib': function(
  //     it, args, output) {
  //   // TODO(chizeng): modify playback to make it work with varying locations.
  //   gl.getActiveAttrib(
  //       /** @type {WebGLProgram} */ (objs[args['program']]), args['index']);
  // },
  // 'WebGLRenderingContext#getActiveUniform': function(
  //     it, args, output) {
  //   // maybe we must modify playback to obtain the new active uniform.
  //   gl.getActiveUniform(
  //       /** @type {WebGLProgram} */ (objs[args['program']]), args['index']);
  // },
  // 'WebGLRenderingContext#getAttachedShaders': function(
  //     it, args, output) {
  //   gl.getAttachedShaders(
  //       /** @type {WebGLProgram} */ (objs[args['program']]));
  // },
  // 'WebGLRenderingContext#getAttribLocation': function(
  //     it, args, output) {
  //   gl.getAttribLocation(
  //       /** @type {WebGLProgram} */ (objs[args['program']]), args['name']);
  // },
  'WebGLRenderingContext#getBufferParameter': function(
      it, args, output) {
    gl.getBufferParameter(
        args['target'], args['pname']);
    output.push('glGetBufferParameteriv(' + [
      args['target'],
      args['pname'],
      '&scratch_data'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#getError': function(
      it, args, output) {
    output.push('glGetError();');
  },
  // 'WebGLRenderingContext#getExtension': function(
  //     it, args, output) {
  //   // TODO(chizeng): Possibly store the extension?
  //   var originalExtension = args['name'];
  //   var relatedExtension =
  //       playback.extensionManager_.getRelatedExtension(originalExtension);
  //   gl.getExtension(relatedExtension || originalExtension);
  // },
  // 'WebGLRenderingContext#getParameter': function(
  //     it, args, output) {
  //   gl.getParameter(args['pname']);
  // },
  // 'WebGLRenderingContext#getFramebufferAttachmentParameter': function(
  //     it, args, output) {
  //   gl.getFramebufferAttachmentParameter(
  //       args['target'], args['attachment'], args['pname']);
  // },
  // 'WebGLRenderingContext#getProgramParameter': function(
  //     it, args, output) {
  //   gl.getProgramParameter(
  //       /** @type {WebGLProgram} */ (objs[args['program']]), args['pname']);
  // },
  // 'WebGLRenderingContext#getProgramInfoLog': function(
  //     it, args, output) {
  //   gl.getProgramInfoLog(
  //       /** @type {WebGLProgram} */ (objs[args['program']]));
  // },
  // 'WebGLRenderingContext#getRenderbufferParameter': function(
  //     it, args, output) {
  //   gl.getRenderbufferParameter(
  //       args['target'], args['pname']);
  // },
  // 'WebGLRenderingContext#getShaderParameter': function(
  //     it, args, output) {
  //   gl.getShaderParameter(
  //       /** @type {WebGLShader} */ (objs[args['shader']]), args['pname']);
  // },
  // 'WebGLRenderingContext#getShaderPrecisionFormat': function(
  //     it, args, output) {
  //   gl.getShaderPrecisionFormat(
  //       args['shadertype'], args['precisiontype']);
  // },
  // 'WebGLRenderingContext#getShaderInfoLog': function(
  //     it, args, output) {
  //   gl.getShaderInfoLog(
  //       /** @type {WebGLShader} */ (objs[args['shader']]));
  // },
  // 'WebGLRenderingContext#getShaderSource': function(
  //     it, args, output) {
  //   gl.getShaderSource(
  //       /** @type {WebGLShader} */ (objs[args['shader']]));
  // },
  // 'WebGLRenderingContext#getTexParameter': function(
  //     it, args, output) {
  //   gl.getTexParameter(
  //       args['target'], args['pname']);
  // },
  // 'WebGLRenderingContext#getUniform': function(
  //     it, args, output) {
  //   gl.getUniform(
  //       /** @type {WebGLProgram} */ (objs[args['program']]),
  //       /** @type {WebGLUniformLocation} */ (objs[args['location']]));
  // },
  'WebGLRenderingContext#getUniformLocation': function(
      it, args, output) {
    output.push('id = glGetUniformLocation(' + [
      'context->GetObject(' + args['program'] + ')',
      '"' + args['name'] + '"'
    ].join(', ') + ');');
    output.push('context->SetObject(' + args['value'] + ', id);');
  },
  // 'WebGLRenderingContext#getVertexAttrib': function(
  //     it, args, output) {
  //   gl.getVertexAttrib(
  //       args['index'], args['pname']);
  // },
  // 'WebGLRenderingContext#getVertexAttribOffset': function(
  //     it, args, output) {
  //   gl.getVertexAttribOffset(
  //       args['index'], args['pname']);
  // },
  'WebGLRenderingContext#hint': function(
      it, args, output) {
    output.push('glHint(' + [
      args['target'], args['mode']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isBuffer': function(
      it, args, output) {
    output.push('glIsBuffer(' + [
      'context->GetObject(' + args['buffer'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isEnabled': function(
      it, args, output) {
    output.push('glIsEnabled(' + [
      args['cap']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isFramebuffer': function(
      it, args, output) {
    output.push('glIsFramebuffer(' + [
      'context->GetObject(' + args['framebuffer'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isProgram': function(
      it, args, output) {
    output.push('glIsProgram(' + [
      'context->GetObject(' + args['program'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isRenderbuffer': function(
      it, args, output) {
    output.push('glIsRenderbuffer(' + [
      'context->GetObject(' + args['renderbuffer'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isShader': function(
      it, args, output) {
    output.push('glIsShader(' + [
      'context->GetObject(' + args['shader'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#isTexture': function(
      it, args, output) {
    output.push('glIsTexture(' + [
      'context->GetObject(' + args['texture'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#lineWidth': function(
      it, args, output) {
    output.push('glLineWidth(' + [
      args['width']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#linkProgram': function(
      it, args, output) {
    // Do all the attribute bindings, then link.
    var attribMap = args['attributes'];
    for (var attribName in attribMap) {
      output.push('glBindAttribLocation(' + [
        'context->GetObject(' + args['program'] + ')',
        attribMap[attribName],
        '"' + attribName + '"'
      ].join(', ') + ');');
    }
    output.push('glLinkProgram(' + [
      'context->GetObject(' + args['program'] + ')'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#pixelStorei': function(
      it, args, output) {
    output.push('glPixelStorei(' + [
      args['pname'], args['param']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#polygonOffset': function(
      it, args, output) {
    output.push('glPolygonOffset(' + [
      args['factor'], args['units']
    ].join(', ') + ');');
  },
  // 'WebGLRenderingContext#readPixels': function(
  //     it, args, output) {
  //   var pixels = new Uint8Array(args['size']);
  //   gl.readPixels(args['x'], args['y'],
  //       args['width'], args['height'], args['format'],
  //       args['type'], pixels);
  // },
  'WebGLRenderingContext#renderbufferStorage': function(
      it, args, output) {
    output.push('glRenderbufferStorage(' + [
      args['target'], args['internalformat'], args['width'], args['height']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#sampleCoverage': function(
      it, args, output) {
    output.push('glSampleCoverage(' + [
      args['value'], args['invert']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#scissor': function(
      it, args, output) {
    output.push('glScissor(' + [
      args['x'], args['y'], args['width'], args['height']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#shaderSource': function(
      it, args, output) {
    var finalSource = args['source'];
    finalSource = finalSource.replace(/\n/g, '\\n');
    finalSource = finalSource.replace(/"/g, '\\"');
    output.push('glShaderSource(' + [
      'context->GetObject(' + args['shader'] + ')',
      '1',
      '(const char*[]){"' + finalSource + '"}',
      '(GLint[]){' + finalSource.length + '}'
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilFunc': function(
      it, args, output) {
    output.push('glStencilFunc(' + [
      args['func'], args['ref'], args['mask']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilFuncSeparate': function(
      it, args, output) {
    output.push('glStencilFuncSeparate(' + [
      args['face'], args['func'], args['ref'], args['mask']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilMask': function(
      it, args, output) {
    output.push('glStencilMask(' + [
      args['mask']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilMaskSeparate': function(
      it, args, output) {
    output.push('glStencilMaskSeparate(' + [
      args['face'], args['mask']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilOp': function(
      it, args, output) {
    output.push('glStencilOp(' + [
      args['fail'], args['zfail'], args['zpass']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#stencilOpSeparate': function(
      it, args, output) {
    output.push('glStencilOpSeparate(' + [
      args['face'], args['fail'], args['zfail'], args['zpass']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#texImage2D': function(
      it, args, output) {
    var dataType = args['dataType'];
    if (dataType == 'pixels') {
      output.push('glTexImage2D(' + [
          args['target'],
          args['level'],
          args['internalformat'],
          args['width'],
          args['height'],
          args['border'],
          args['format'],
          args['type'],
          '(const GLvoid*)' + arrayToString(args['pixels'])
      ].join(', ') + ');');
    } else if (dataType == 'null') {
      output.push('glTexImage2D(' + [
        args['target'],
        args['level'],
        args['internalformat'],
        args['width'],
        args['height'],
        args['border'],
        args['format'],
        args['type'],
        '0'
      ].join(', ') + ');');
    } else {
      // gl.texImage2D(
      //     args['target'],
      //     args['level'],
      //     args['internalformat'],
      //     args['format'],
      //     args['type'],
      //     /** @type {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} */
      //     (playback.resources_[eventId])
      // );
      output.push('// UNHANDLED TEXIMAGE2D');
    }
  },
  'WebGLRenderingContext#texSubImage2D': function(
      it, args, output) {
    var dataType = args['dataType'];
    if (dataType == 'pixels') {
      // gl.texSubImage2D(
      //     args['target'],
      //     args['level'],
      //     args['xoffset'],
      //     args['yoffset'],
      //     args['width'],
      //     args['height'],
      //     args['format'],
      //     args['type'],
      //     playback.coercePixelType_(args['type'], args['pixels'])
      // );
      output.push('glTexSubImage2D(' + [
        args['target'],
        args['level'],
        args['xoffset'],
        args['yoffset'],
        args['width'],
        args['height'],
        args['format'],
        args['type'],
        '(const GLvoid*)' + arrayToString(args['pixels'])
      ].join(', ') + ');');
    } else if (dataType == 'null') {
      output.push('glTexSubImage2D(' + [
        args['target'],
        args['level'],
        args['xoffset'],
        args['yoffset'],
        args['width'],
        args['height'],
        args['format'],
        args['type'],
        '0'
      ].join(', ') + ');');
    } else {
      // gl.texSubImage2D(
      //     args['target'],
      //     args['level'],
      //     args['xoffset'],
      //     args['yoffset'],
      //     args['format'],
      //     args['type'],
      //     /** @type {HTMLCanvasElement|HTMLImageElement|HTMLVideoElement} */
      //     (playback.resources_[eventId])
      // );
      output.push('// UNHANDLED TEXSUBIMAGE2D');
    }
  },
  'WebGLRenderingContext#texParameterf': function(
      it, args, output) {
    output.push('glTexParameterf(' + [
      args['target'], args['pname'], args['param']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#texParameteri': function(
      it, args, output) {
    output.push('glTexParameteri(' + [
      args['target'], args['pname'], args['param']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform1f': function(
      it, args, output) {
    output.push('glUniform1f(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform1fv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform1fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 1,
      arrayToString(v),
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform1i': function(
      it, args, output) {
    output.push('glUniform1i(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform1iv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform1iv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 1,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform2f': function(
      it, args, output) {
    output.push('glUniform2f(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform2fv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform2fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 2,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform2i': function(
      it, args, output) {
    output.push('glUniform2i(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform2iv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform2iv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 2,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform3f': function(
      it, args, output) {
    output.push('glUniform3f(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y'], args['z']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform3fv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform3fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 3,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform3i': function(
      it, args, output) {
    output.push('glUniform3i(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y'], args['z']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform3iv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform3iv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 3,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform4f': function(
      it, args, output) {
    output.push('glUniform4f(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y'], args['z'], args['w']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform4fv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform4fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 4,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform4i': function(
      it, args, output) {
    output.push('glUniform4i(' + [
      'context->GetObject(' + args['location'] + ')',
      args['x'], args['y'], args['z'], args['w']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniform4iv': function(
      it, args, output) {
    var v = args['v'];
    output.push('glUniform4iv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 4,
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniformMatrix2fv': function(
      it, args, output) {
    var v = args['value'];
    output.push('glUniformMatrix2fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 4,
      args['transpose'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniformMatrix3fv': function(
      it, args, output) {
    var v = args['value'];
    output.push('glUniformMatrix3fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 9,
      args['transpose'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#uniformMatrix4fv': function(
      it, args, output) {
    var v = args['value'];
    output.push('glUniformMatrix4fv(' + [
      'context->GetObject(' + args['location'] + ')',
      v.length / 16,
      args['transpose'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#useProgram': function(
      it, args, output) {
    output.push('glUseProgram(' + [
      'context->GetObject(' + args['program'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#validateProgram': function(
      it, args, output) {
    output.push('glValidateProgram(' + [
      'context->GetObject(' + args['program'] + ')',
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib1fv': function(
      it, args, output) {
    var v = args['values'];
    output.push('glVertexAttrib1fv(' + [
      args['indx'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib2fv': function(
      it, args, output) {
    var v = args['values'];
    output.push('glVertexAttrib2fv(' + [
      args['indx'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib3fv': function(
      it, args, output) {
    var v = args['values'];
    output.push('glVertexAttrib3fv(' + [
      args['indx'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib4fv': function(
      it, args, output) {
    var v = args['values'];
    output.push('glVertexAttrib4fv(' + [
      args['indx'],
      arrayToString(v)
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib1f': function(
      it, args, output) {
    output.push('glVertexAttrib1f(' + [
      args['indx'], args['x']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib2f': function(
      it, args, output) {
    output.push('glVertexAttrib2f(' + [
      args['indx'], args['x'], args['y']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib3f': function(
      it, args, output) {
    output.push('glVertexAttrib3f(' + [
      args['indx'], args['x'], args['y'], args['z']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttrib4f': function(
      it, args, output) {
    output.push('glVertexAttrib4f(' + [
      args['indx'], args['x'], args['y'], args['z'], args['w']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#vertexAttribPointer': function(
      it, args, output) {
    output.push('glVertexAttribPointer(' + [
      args['indx'],
      args['size'],
      args['type'],
      args['normalized'],
      args['stride'],
      '(const GLvoid*)' + args['offset']
    ].join(', ') + ');');
  },
  'WebGLRenderingContext#viewport': function(
      it, args, output) {
    output.push('glViewport(' + [
      args['x'], args['y'], args['width'], args['height']
    ].join(', ') + ');');
  },

  'ANGLEInstancedArrays#drawArraysInstancedANGLE': function(
      it, args, output) {
    output.push('glDrawArraysInstanced(' + [
      args['mode'],
      args['first'],
      args['count'],
      args['primcount']
    ].join(', ') + ');');
  },
  'ANGLEInstancedArrays#drawElementsInstancedANGLE': function(
      it, args, output) {
    output.push('glDrawElementsInstanced(' + [
      args['mode'],
      args['count'],
      args['type'],
      '(const GLvoid*)' + args['offset'],
      args['primcount']
    ].join(', ') + ');');
  },
  'ANGLEInstancedArrays#vertexAttribDivisorANGLE': function(
      it, args, output)  {
    output.push('glVertexAttribDivisor(' + [
      args['index'],
      args['divisor']
    ].join(', ') + ');');
  },

  'WebGLRenderingContext#isContextLost': function(it, args, output) {
    // Ignored.
  },

  'wtf.webgl#createContext': function(it, args, output) {
    var attributes = args['attributes'];
    var contextHandle = args['handle'];

    var callArgs = [
      contextHandle
    ];

    if (attributes) {
      // TODO(benvanik): attributes.
    }

    output.push(
        'context = replay->CreateContext(' + callArgs.join(', ') + ');');
  },
  'wtf.webgl#setContext': function(it, args, output) {
    var contextHandle = args['handle'];
    var width = args['width'];
    var height = args['height'];

    var callArgs = [
      contextHandle,
      width,
      height
    ];
    output.push(
        'context = replay->MakeContextCurrent(' + callArgs.join(', ') + ');');
  }
};
