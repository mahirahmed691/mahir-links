// One shop in, one LinkedIn note out. The hourly Alexa feed stays on GitHub Actions.
// Point a Jenkins Pipeline job at this file. The agent needs Node.js 20 or newer.
pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
    buildDiscarder(logRotator(numToKeepStr: '20'))
  }

  parameters {
    string(name: 'SITE_NAME', description: 'Name to use in the note, for example Tara\'s Bakes')
    string(name: 'SITE_URL', description: 'Public https address of the shop')
  }

  stages {
    stage('Write the LinkedIn note') {
      steps {
        script {
          def name = params.SITE_NAME?.trim()
          def url = params.SITE_URL?.trim()
          if (!name || !url) {
            error 'Set SITE_NAME and SITE_URL, then run the job again.'
          }
          writeFile file: 'site-status/pitch-request.json', text: groovy.json.JsonOutput.toJson([name: name, url: url])
        }
        dir('site-status') {
          sh 'node --version'
          sh 'node scripts/pitch.mjs pitch-request.json pitch.txt'
        }
      }
    }
  }

  post {
    success {
      archiveArtifacts artifacts: 'site-status/pitch.txt', onlyIfSuccessful: true
    }
    cleanup {
      sh 'rm -f site-status/pitch-request.json site-status/pitch.txt'
    }
  }
}
