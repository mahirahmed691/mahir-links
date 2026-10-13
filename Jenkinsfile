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
    choice(
      name: 'SHOP',
      choices: "Mahir Ahmed\nFlickFinder\nSakinah\nMotiv\nKARV'D\nKiano London\nSweet Dezire\nBlanco Coffee House\nRAPIDER\nD Apartment Sylhet\nAbayas Boutique\nTara's Bakes",
      description: 'Shop to check. The address comes from the site list.'
    )
  }

  stages {
    stage('Write the LinkedIn note') {
      steps {
        script {
          def shop = params.SHOP?.trim()
          if (!shop) {
            error 'Pick a shop from the list, then run the job again.'
          }
          writeFile file: 'site-status/pitch-request.json', text: groovy.json.JsonOutput.toJson([name: shop])
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
