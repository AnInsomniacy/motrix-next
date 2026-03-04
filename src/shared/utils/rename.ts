const RULE_REGEX = /\(([^)]*)\)/
const PLUS = '+'
const MINUS = '-'
const OPERATORS = [PLUS, MINUS]

export const getRuleString = (out: string): string | null => {
    const rule = out.match(RULE_REGEX)
    return rule && rule[1]
}

export const buildRule = (rule: string) => {
    let ruleArr: string[] | undefined
    let operator = PLUS
    let init = 1
    let step: number = 1
    let len = 1

    OPERATORS.some((OPT) => {
        if (rule.includes(OPT)) {
            ruleArr = rule.split(OPT)
            operator = OPT
            return true
        }
        return false
    })

    if (ruleArr) {
        len = ruleArr[0].length
        init = parseInt(ruleArr[0], 10)
        step = parseInt(ruleArr[1], 10) || 1
        if (operator === MINUS) {
            step = -step
        }
    }

    return { init, step, len }
}

export const buildOuts = (uris: string[] = [], out = ''): string[] => {
    const result: string[] = []
    const count = uris.length
    if (count === 0 || !out) {
        return result
    }

    if (count === 1) {
        return [out]
    }

    const ruleStr = getRuleString(out)
    if (!ruleStr) {
        return result
    }
    const rule = buildRule(ruleStr)

    let idx: string
    let temp: string

    for (let i = 0; i < count; i++) {
        idx = `${rule.init + rule.step * i}`.padStart(rule.len, '0')
        temp = out.replace(RULE_REGEX, idx)
        result.push(temp)
    }

    return result
}
