module.exports = (grunt) ->

  path = require('path');

  grunt.initConfig {
    pkg: grunt.file.readJSON('package.json'),

    copy: {
      app: {
        files: [
          {
            src: ['**']
            dest: 'chrome/js/'
            expand: true,
            cwd: 'tmp'
          }, {
            src: 'node_modules/freedom/freedom.js'
            dest: 'chrome/js/freedom.js'
          }, {
            src: ['**/*.json']
            dest: 'chrome/js/'
            expand: true,
            cwd: 'src'
          },
        ]
      }
    }

    # All typescript compiles to tmp/ initially.
    ts: {
      socks2rtc: {
        src: ['src/interfaces/*.d.ts',
              'src/socks-to-rtc/*.ts'],
        outDir: 'tmp/socks-to-rtc/',
        options: {
          sourceMap: false
        }
      }
      rtc2net: {
        src: ['src/interfaces/*.d.ts',
              'src/rtc-to-net/*.ts'],
        outDir: 'tmp/rtc-to-net/',
        options: {
          sourceMap: false
        }
      }
      chromeFSocket: {
        src: ['src/chrome-fsocket.ts'],
        outDir: 'tmp/',
        options: { sourceMap: false; }
      }
    }

    shell: {
      freedom_setup: {
        command: 'npm install',
        options: {stdout: true, stderr: true, failOnError: true, execOptions: {cwd: 'node_modules/freedom'}}
      }
      freedom_build: {
        command: 'grunt',
        options: {stdout: true, stderr: true, failOnError: true, execOptions: {cwd: 'node_modules/freedom'}}
      }
    }

    jasmine: {
      # Eventually, this should be a wildcard once we've figured out how to run
      # more dependencies under Jasmine.
      src: 'chrome/js/socks-to-rtc/socks.js',
      options : {
        specs : 'spec/**/*_spec.js'
      }
    }

    env: {
      jasmine_node: {
        # Will be available to tests as process.env['CHROME_EXTENSION_PATH'].
        CHROME_EXTENSION_PATH: path.resolve('chrome')
      }
    }

    jasmine_node: {
      projectRoot: 'spec/selenium'
    }

    clean: [
      'tmp/**',
      'chrome/js/**'
    ]
  }

  grunt.loadNpmTasks 'grunt-contrib-copy'
  grunt.loadNpmTasks 'grunt-contrib-clean'
  grunt.loadNpmTasks 'grunt-contrib-jasmine'
  grunt.loadNpmTasks 'grunt-shell'
  grunt.loadNpmTasks 'grunt-ts'
  grunt.loadNpmTasks 'grunt-jasmine-node'
  grunt.loadNpmTasks 'grunt-env'

  grunt.registerTask 'build', [
    'ts:socks2rtc',
    'ts:rtc2net',
    'ts:chromeFSocket',
    'copy:app'
  ]

  # This is the target run by Travis. Targets in here should run locally
  # and on Travis.
  grunt.registerTask 'test', [
    'build',
    'jasmine'
  ]

  # Right now, the Selenium tests only run locally and require that
  # selenium-server be running on localhost:4444. You can do that by:
  #  - downloading the "Standalone Server" from
  #    http://docs.seleniumhq.org/download/
  #  - running java -jar selenium-server-standalone-*.jar
  # TODO(yangoon): Figure out how to run our Selenium tests on Sauce Labs,
  #                add them to the test target, and remove this target.
  # TODO(yangoon): Have this task spin up a selenium server.
  grunt.registerTask 'endtoend', [
    'build',
    'env',
    'jasmine_node'
  ]

  grunt.registerTask 'default', [
    'build'
  ]

  # Freedom doesn't build correctly by itself - run this task when in a clean
  # directory.
  grunt.registerTask 'setup', [
    'shell:freedom_setup',
    'shell:freedom_build'
  ]
